// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/**
 * The WebSocket side: one Studio tab at a time, on 127.0.0.1 only, from an
 * allowed Origin only, after a mutual HMAC proof of the pairing token (or of
 * the resume key both derived when they paired) bound to this port; then
 * every frame is MACed with the session key and a sequence number (see
 * protocol.ts). The token never crosses the wire and has ~130 bits, so a
 * relay proof is no use for guessing it offline. Five wrong proofs replace it
 * (at most once a minute). Token hellos after more than 30 failed or
 * unfinished handshakes in a minute are answered late (growing, up to 5 s);
 * successful pairings and resume hellos never count or wait, so nothing on
 * the machine can block pairing.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { CHUNK_BYTES, ModelFileError, readModelFiles } from './modelFile.js';
import { type Content, IMPORT_FILE, IMPORT_PART, MAX_FRAME, macText, PROTOCOL, parseTabMessage, proofText, type RelayMessage, type ToolInfo, tokenKey } from './protocol.js';

export const hmac = (key: string, text: string) => createHmac('sha256', key).update(text).digest('hex');

export const DEFAULT_PORT = 3021;
export const DEFAULT_ORIGINS = ['https://studio.stroq.club', 'http://localhost:3020'];
/** A handshake must finish within this time. */
export const HANDSHAKE_MS = 30_000;
/** Longest a tool call may take (wait_for_comments waits up to 10 min). */
export const CALL_TIMEOUT_MS = 11 * 60_000;
/** Wrong proofs before the token is replaced; replaced at most once per ROTATE_MS. */
export const MAX_WRONG = 5;
export const ROTATE_MS = 60_000;
/** Failed or unfinished handshakes a minute before token hellos are slowed down. */
export const FREE_STRIKES_PER_MIN = 30;
/** Delay per strike past the free ones, and its cap. */
export const STRIKE_DELAY_MS = 250;
export const MAX_DELAY_MS = 5_000;
/**
 * A tab that goes away (a reload) has this long to resume before the relay
 * counts it gone: the tool list stays, calls made meanwhile wait for it, and a
 * pending wait_for_comments carries on in the tab that comes back.
 */
export const GRACE_MS = 30_000;
/** Said when a tab went away and did not come back within GRACE_MS. */
export const TAB_GONE = 'The Studio tab is not connected (it went away and did not come back in time)';

/** The one string the person pastes into the Studio: port and token. */
export const pairingString = (port: number, token: string) => `${port}:${token}`;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A 26-character base32 token (130 random bits), grouped for pasting: XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX. */
export function newToken(): string {
  const bytes = randomBytes(17);
  let bits = 0;
  let acc = 0;
  let s = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && s.length < 26) {
      s += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return s.match(/.{1,5}/g)!.join('-').replace(/-(\w)$/, '$1');
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type RelayStatus =
  | { state: 'waiting'; pairing: string; token: string; port: number }
  | { state: 'connected'; origin: string; tools: number; port: number }
  | { state: 'reconnecting'; origin: string; tools: number; port: number; pairing: string; token: string };

/** A call's result; `dropped`: the tab went away before answering (it may or may not have run it). */
export type CallResult = { content: Content[]; isError: boolean; dropped?: boolean };

export interface RelayOptions {
  /** A fixed port (fails when busy). Without it: DEFAULT_PORT, else any free port. */
  port?: number;
  origins?: string[];
  /** Where messages for the person go (stderr in the CLI; stdout belongs to MCP). */
  log?: (line: string) => void;
  onToolsChanged?: () => void;
  /** How long a dropped tab may take to resume (default GRACE_MS). */
  graceMs?: number;
}

interface Pending {
  resolve: (r: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Relay {
  private fixedPort: number | null;
  /** The port it listens on (known once started). */
  port: number;
  readonly origins: string[];
  private wss: WebSocketServer | null = null;
  private token = newToken();
  private resume: string | null = null;
  private tab: { ws: WebSocket; origin: string; session: string; seqOut: number } | null = null;
  private wrong = 0;
  private lastRotate = 0;
  /** When failed or unfinished token handshakes ended (last minute). */
  private strikes: number[] = [];
  private toolList: ToolInfo[] = [];
  /** While a dropped tab may resume: when the grace ends, its timer, and who waits for the tab. */
  private grace: { origin: string; until: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private resumed: Array<() => void> = [];
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private log: (line: string) => void;
  private onToolsChanged: () => void;
  private graceMs: number;

  constructor(opts: RelayOptions = {}) {
    this.fixedPort = opts.port ?? null;
    this.port = opts.port ?? DEFAULT_PORT;
    this.origins = opts.origins ?? DEFAULT_ORIGINS;
    this.log = opts.log ?? (() => undefined);
    this.onToolsChanged = opts.onToolsChanged ?? (() => undefined);
    this.graceMs = opts.graceMs ?? GRACE_MS;
  }

  get pairingToken() {
    return this.token;
  }

  /** What the person pastes: "port:TOKEN". */
  get pairing() {
    return pairingString(this.port, this.token);
  }

  /** The tab's tools; kept while a dropped tab may still resume (GRACE_MS). */
  get tools(): ToolInfo[] {
    return this.tab || this.grace ? this.toolList : [];
  }

  /** Whether a tab is linked, or dropped and may still resume. */
  get linked(): boolean {
    return !!this.tab || !!this.grace;
  }

  status(): RelayStatus {
    if (this.tab) return { state: 'connected', origin: this.tab.origin, tools: this.toolList.length, port: this.port };
    if (this.grace) return { state: 'reconnecting', origin: this.grace.origin, tools: this.toolList.length, port: this.port, pairing: this.pairing, token: this.token };
    return { state: 'waiting', pairing: this.pairing, token: this.token, port: this.port };
  }

  /** Resolves true once a tab is connected (with its tool list), false at `until` or when the grace ends without one. */
  waitForTab(until: number): Promise<boolean> {
    if (this.tab) return Promise.resolve(true);
    if (!this.grace) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(t);
        this.resumed = this.resumed.filter((f) => f !== wake);
        resolve(ok);
      };
      const wake = () => done(!!this.tab);
      const t = setTimeout(() => done(false), Math.max(0, until - Date.now()));
      this.resumed.push(wake);
    });
  }

  private wakeWaiters() {
    const w = this.resumed;
    this.resumed = [];
    for (const f of w) f();
  }

  /** Starts listening on 127.0.0.1: the fixed port, else DEFAULT_PORT, else any free port (said on the log). */
  async start(): Promise<void> {
    if (this.fixedPort !== null) return this.listen(this.fixedPort);
    try {
      await this.listen(DEFAULT_PORT);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      await this.listen(0);
      this.log(`Port ${DEFAULT_PORT} is taken, so the relay uses port ${this.port}.`);
      this.announce();
    }
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: MAX_FRAME, verifyClient: (info: { origin: string; req: IncomingMessage }) => this.allowed(info.origin, info.req) });
      wss.once('error', (e) => {
        wss.close();
        reject(e);
      });
      wss.once('listening', () => {
        wss.removeAllListeners('error');
        wss.on('error', (e) => this.log(`WebSocket error: ${e.message}`));
        this.wss = wss;
        this.port = (wss.address() as { port: number }).port;
        if (port !== 0) this.announce();
        resolve();
      });
      wss.on('connection', (ws, req) => this.accept(ws, req.headers.origin ?? ''));
    });
  }

  async stop(): Promise<void> {
    this.failAll('The relay stopped');
    this.tab?.ws.close(1001, 'relay stopping');
    this.tab = null;
    if (this.grace) clearTimeout(this.grace.timer);
    this.grace = null;
    this.wakeWaiters();
    const wss = this.wss;
    this.wss = null;
    if (wss) {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  }

  /** Runs a tool in the tab. Never throws: errors come back as isError content. */
  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    // A dropped tab (a reload): wait for it to resume, within the grace period.
    if (!this.tab && this.grace && !(await this.waitForTab(this.grace.until))) return err(`${TAB_GONE}. Reload the Studio, or connect again with ${this.pairing}.`);
    const tab = this.tab;
    if (!tab) return err(`No Studio tab is connected. In the Studio: Tools → AI agent → Connect… and paste ${this.pairing}.`);
    if (!this.toolList.some((t) => t.name === name)) return Promise.resolve(err(`The Studio has no tool "${name}"`));
    const id = this.nextId++;
    return new Promise<CallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(err(`"${name}" took longer than ${CALL_TIMEOUT_MS / 60_000} minutes`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.send(tab.ws, { type: 'call', id, name, arguments: args });
    });
  }

  /** Whether the tab takes model files (it lists both import tools). */
  get canImport(): boolean {
    return !!this.tab && this.toolList.some((t) => t.name === IMPORT_FILE) && this.toolList.some((t) => t.name === IMPORT_PART);
  }

  /**
   * import_model_file: reads the model here (modelFile.ts checks), sends it to
   * the tab in CHUNK_BYTES parts (one import_model_part call each, in order,
   * each answered before the next), then asks the tab to import it.
   */
  async importModelFile(args: Record<string, unknown>): Promise<CallResult> {
    if (!this.tab) return this.call(IMPORT_FILE, {});
    if (!this.canImport) return err('This Studio tab cannot import model files: reload it, or update the Studio');
    let files: Awaited<ReturnType<typeof readModelFiles>>;
    let lowPoly: typeof files | null = null;
    let far: typeof files | null = null;
    const high = args.highPath ?? args.path;
    if (high === undefined) return err('Give highPath (or path): the absolute path of the model');
    try {
      files = await readModelFiles(high as string);
    } catch (e) {
      return err(e instanceof ModelFileError ? e.message : `Could not read the model: ${(e as Error).message}`);
    }
    // lowPolyPath is the old name of lowPolyStylePath.
    const stylePath = args.lowPolyStylePath ?? args.lowPolyPath;
    if (stylePath !== undefined) {
      try {
        lowPoly = await readModelFiles(stylePath as string);
      } catch (e) {
        return err(`Low-poly version: ${e instanceof ModelFileError ? e.message : `could not read it: ${(e as Error).message}`}`);
      }
    }
    if (args.farPath !== undefined) {
      try {
        far = await readModelFiles(args.farPath as string);
      } catch (e) {
        return err(`Far level: ${e instanceof ModelFileError ? e.message : `could not read it: ${(e as Error).message}`}`);
      }
    }
    const send = async (fs: typeof files) => {
      const upload = randomBytes(12).toString('hex');
      for (const f of fs) {
        for (let offset = 0; offset < f.data.length || offset === 0; offset += CHUNK_BYTES) {
          const data = Buffer.from(f.data.subarray(offset, offset + CHUNK_BYTES)).toString('base64');
          const r = await this.call(IMPORT_PART, { upload, file: f.name, size: f.data.length, offset, data });
          if (r.isError) return r;
          if (f.data.length === 0) break;
        }
      }
      return upload;
    };
    const upload = await send(files);
    if (typeof upload !== 'string') return upload;
    const list = (fs: typeof files) => fs.map((f) => ({ name: f.name, size: f.data.length }));
    let low = {};
    if (lowPoly) {
      const lowUpload = await send(lowPoly);
      if (typeof lowUpload !== 'string') return lowUpload;
      low = { lowPolyUpload: lowUpload, lowPolyFiles: list(lowPoly) };
    }
    let farArgs = {};
    if (far) {
      const farUpload = await send(far);
      if (typeof farUpload !== 'string') return farUpload;
      farArgs = { farUpload, farFiles: list(far) };
    }
    const pick = (k: string) => (args[k] === undefined ? {} : { [k]: args[k] });
    return this.call(IMPORT_FILE, { upload, files: list(files), ...low, ...farArgs, ...pick('name'), ...pick('category'), ...pick('tags'), ...pick('bake') });
  }

  private allowed(origin: string, req: IncomingMessage): boolean {
    // Only from this machine (the bind already ensures it) and only from the Studio's origins.
    const host = req.socket.remoteAddress ?? '';
    if (host !== '127.0.0.1' && host !== '::ffff:127.0.0.1') return false;
    if (!this.origins.includes(origin)) {
      this.log(`Refused a connection from origin "${origin || '(none)'}" (allowed: ${this.origins.join(', ')})`);
      return false;
    }
    return true;
  }

  private announce() {
    this.log(`Strōq Studio relay on ws://127.0.0.1:${this.port}. In the Studio: Tools → AI agent → Connect… and paste ${this.pairing}`);
  }

  private accept(ws: WebSocket, origin: string) {
    let paired = false;
    /** After hello: the nonces and the key this attempt uses. */
    let attempt: { tabNonce: string; relayNonce: string; key: string; mode: 'token' | 'resume' } | null = null;
    let session = '';
    let seqIn = 0;
    const timer = setTimeout(() => {
      if (!paired) ws.close(4000, 'not paired in time');
    }, HANDSHAKE_MS);
    const refuse = (why: string) => {
      this.sendPlain(ws, { type: 'refused', reason: why });
      ws.close(4003, 'refused');
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4002, 'text frames only');
      const msg = parseTabMessage(data.toString());
      if (!msg) return ws.close(4001, 'bad frame');
      if (!paired) {
        if (!attempt) {
          if (msg.type !== 'hello') return ws.close(4001, 'hello first');
          if (msg.protocol !== PROTOCOL) return refuse(`This relay speaks protocol ${PROTOCOL}, the Studio ${msg.protocol}: update @atropical/stroq-studio-mcp, or reload the Studio`);
          if (this.tab) return refuse('Another Studio tab is connected. Disconnect it first.');
          if (msg.port !== this.port) return refuse(`This relay listens on port ${this.port}, not ${msg.port}.`);
          const key = msg.mode === 'resume' ? this.resume : tokenKey(this.token);
          if (!key) return refuse('Nothing to resume: connect with the pairing token.');
          const relayNonce = randomBytes(32).toString('hex');
          const a = { tabNonce: msg.nonce, relayNonce, key, mode: msg.mode };
          attempt = a;
          const challenge = () => this.sendPlain(ws, { type: 'challenge', nonce: relayNonce, proof: hmac(key, proofText('relay', this.port, a.tabNonce, relayNonce)) });
          // Resume hellos (a 256-bit key) never wait; token hellos wait while failed handshakes pile up.
          const wait = msg.mode === 'token' ? this.delay() : 0;
          if (!wait) return challenge();
          this.sendPlain(ws, { type: 'wait', ms: wait });
          setTimeout(challenge, wait);
          return;
        }
        if (msg.type !== 'prove') return ws.close(4001, 'prove next');
        const p = attempt;
        if (!sameSecret(msg.proof, hmac(p.key, proofText('tab', this.port, p.tabNonce, p.relayNonce))))
          return refuse(p.mode === 'resume' ? 'The resume key no longer matches: connect with the pairing token.' : this.wrongProof());
        if (this.tab) return refuse('Another Studio tab is connected. Disconnect it first.');
        clearTimeout(timer);
        paired = true;
        this.wrong = 0;
        if (p.mode === 'token') this.token = newToken(); // one-time: used up once it pairs
        // Bound to this proof: only the tab that proved it can derive them.
        this.resume = hmac(p.key, proofText('resume', this.port, p.tabNonce, p.relayNonce));
        session = hmac(p.key, proofText('session', this.port, p.tabNonce, p.relayNonce));
        this.tab = { ws, origin, session, seqOut: 0 };
        // A tab back within the grace period: its tool list arrives next and wakes who waits.
        if (this.grace) clearTimeout(this.grace.timer);
        this.send(ws, { type: 'welcome', protocol: PROTOCOL });
        this.log(`Studio tab connected (${origin})`);
        return;
      }
      // Paired: only sealed frames, in order, with a good MAC.
      if (msg.type !== 'sealed' || msg.seq !== seqIn || !sameSecret(msg.mac, hmac(session, macText('tab', msg.seq, msg.body)))) return ws.close(4004, 'bad or replayed frame');
      seqIn++;
      const inner = parseTabMessage(msg.body);
      if (!inner) return ws.close(4001, 'bad frame');
      switch (inner.type) {
        case 'tools': {
          // After a resume the same list says nothing new: no list_changed for a reload.
          const same = !!this.grace && JSON.stringify(inner.tools) === JSON.stringify(this.toolList);
          this.grace = null;
          this.toolList = inner.tools;
          if (!same) this.onToolsChanged();
          this.wakeWaiters();
          break;
        }
        case 'result': {
          const r = this.pending.get(inner.id);
          if (!r) break;
          clearTimeout(r.timer);
          this.pending.delete(inner.id);
          r.resolve({ content: inner.content, isError: !!inner.isError });
          break;
        }
        case 'ping':
          this.send(ws, { type: 'pong' });
          break;
        case 'pong':
          break;
        default:
          return ws.close(4001, 'bad frame');
      }
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      // A token handshake that failed or was never finished counts; a successful one never does.
      if (!paired && attempt?.mode === 'token') this.strikes.push(Date.now());
      if (!paired || this.tab?.ws !== ws) return;
      this.tab = null;
      // Calls the tab never answered: wait_for_comments carries on in the tab that resumes (mcp.ts).
      this.failAll('The Studio tab went away before answering; it may or may not have run it', true);
      this.token = newToken();
      // Switched off in the Studio (1000), or closed for a bad frame (4xxx): no resume.
      if (code === 1000 || code >= 4000) return this.gone(code === 1000 ? 'Studio tab switched off.' : 'Studio tab disconnected.');
      if (this.grace) clearTimeout(this.grace.timer);
      // Tools and waiters only change if the tab does not come back in time (or once it never had tools).
      this.grace = { origin, until: Date.now() + GRACE_MS, timer: setTimeout(() => this.gone('The Studio tab did not come back.'), this.graceMs) };
      this.log(`Studio tab disconnected; waiting ${Math.round(this.graceMs / 1000)} s for it to resume (reloading the same tab reconnects by itself).`);
      this.announce();
    });
  }

  /** How long a token hello waits: 0 up to FREE_STRIKES_PER_MIN strikes in the last minute, then growing to MAX_DELAY_MS. */
  delay(now = Date.now()): number {
    this.strikes = this.strikes.filter((t) => now - t < 60_000);
    const over = this.strikes.length - FREE_STRIKES_PER_MIN;
    return over <= 0 ? 0 : Math.min(MAX_DELAY_MS, over * STRIKE_DELAY_MS);
  }

  /** A wrong token proof: counted; MAX_WRONG of them replace the token, at most once per ROTATE_MS. */
  private wrongProof(now = Date.now()): string {
    this.wrong++;
    if (this.wrong >= MAX_WRONG && now - this.lastRotate >= ROTATE_MS) {
      this.wrong = 0;
      this.lastRotate = now;
      this.token = newToken();
      this.log(`${MAX_WRONG} wrong tokens: the pairing token changed.`);
      this.announce();
    }
    return 'Wrong pairing token. Copy the one the relay printed.';
  }

  /** The tab is gone for good: no tools, waiters told, the person told how to pair again. */
  private gone(line: string) {
    if (this.grace) clearTimeout(this.grace.timer);
    this.grace = null;
    this.toolList = [];
    this.onToolsChanged();
    this.wakeWaiters();
    this.log(line);
    this.announce();
  }

  private failAll(why: string, dropped = false) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(dropped ? { ...err(why), dropped: true } : err(why));
      this.pending.delete(id);
    }
  }

  /** Before pairing: challenge and refused only. */
  private sendPlain(ws: WebSocket, m: RelayMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  }

  /** To the paired tab: sealed with the session key and the next sequence number. */
  private send(ws: WebSocket, m: RelayMessage) {
    const tab = this.tab;
    if (!tab || tab.ws !== ws || ws.readyState !== ws.OPEN) return;
    const body = JSON.stringify(m);
    const seq = tab.seqOut++;
    ws.send(JSON.stringify({ type: 'sealed', seq, body, mac: hmac(tab.session, macText('relay', seq, body)) }));
  }
}

const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
