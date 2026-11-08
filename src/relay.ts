// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/**
 * The WebSocket side: one Studio tab at a time, on 127.0.0.1 only, from an
 * allowed Origin only, after a mutual HMAC proof of the pairing token (or of
 * the resume key both derived when they paired) bound to this port; then
 * every frame is MACed with the session key and a sequence number (see
 * protocol.ts). The token never crosses the wire, and any handshake that
 * fails or is left unfinished replaces it, so a relay proof is never an
 * oracle for guessing it offline.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Content, MAX_FRAME, macText, PROTOCOL, parseTabMessage, proofText, type RelayMessage, type ToolInfo, tokenKey } from './protocol.js';

export const hmac = (key: string, text: string) => createHmac('sha256', key).update(text).digest('hex');

export const DEFAULT_PORT = 3021;
export const DEFAULT_ORIGINS = ['https://studio.stroq.club', 'http://localhost:3020'];
/** A handshake must finish within this time; one that does not replaces the token. */
export const HANDSHAKE_MS = 30_000;
/** Longest a tool call may take (wait_for_comments waits up to 10 min). */
export const CALL_TIMEOUT_MS = 11 * 60_000;

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

export type RelayStatus = { state: 'waiting'; token: string; port: number } | { state: 'connected'; origin: string; tools: number; port: number };

export interface RelayOptions {
  port?: number;
  origins?: string[];
  /** Where messages for the person go (stderr in the CLI; stdout belongs to MCP). */
  log?: (line: string) => void;
  onToolsChanged?: () => void;
}

interface Pending {
  resolve: (r: { content: Content[]; isError: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Relay {
  readonly port: number;
  readonly origins: string[];
  private wss: WebSocketServer | null = null;
  private token = newToken();
  private resume: string | null = null;
  private tab: { ws: WebSocket; origin: string; session: string; seqOut: number } | null = null;
  private toolList: ToolInfo[] = [];
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private log: (line: string) => void;
  private onToolsChanged: () => void;

  constructor(opts: RelayOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.origins = opts.origins ?? DEFAULT_ORIGINS;
    this.log = opts.log ?? (() => undefined);
    this.onToolsChanged = opts.onToolsChanged ?? (() => undefined);
  }

  get pairingToken() {
    return this.token;
  }

  get tools(): ToolInfo[] {
    return this.tab ? this.toolList : [];
  }

  status(): RelayStatus {
    return this.tab ? { state: 'connected', origin: this.tab.origin, tools: this.toolList.length, port: this.port } : { state: 'waiting', token: this.token, port: this.port };
  }

  /** Starts listening on 127.0.0.1. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: this.port, maxPayload: MAX_FRAME, verifyClient: (info: { origin: string; req: IncomingMessage }) => this.allowed(info.origin, info.req) });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        wss.on('error', (e) => this.log(`WebSocket error: ${e.message}`));
        this.wss = wss;
        this.announce();
        resolve();
      });
      wss.on('connection', (ws, req) => this.accept(ws, req.headers.origin ?? ''));
    });
  }

  async stop(): Promise<void> {
    this.failAll('The relay stopped');
    this.tab?.ws.close(1001, 'relay stopping');
    this.tab = null;
    const wss = this.wss;
    this.wss = null;
    if (wss) {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  }

  /** Runs a tool in the tab. Never throws: errors come back as isError content. */
  call(name: string, args: Record<string, unknown>): Promise<{ content: Content[]; isError: boolean }> {
    const tab = this.tab;
    if (!tab) return Promise.resolve(err(`No Studio tab is connected. In the Studio: Help → Connect an agent, port ${this.port}, token ${this.token}.`));
    if (!this.toolList.some((t) => t.name === name)) return Promise.resolve(err(`The Studio has no tool "${name}"`));
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(err(`"${name}" took longer than ${CALL_TIMEOUT_MS / 60_000} minutes`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.send(tab.ws, { type: 'call', id, name, arguments: args });
    });
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
    this.log(`Strōq Studio relay on ws://127.0.0.1:${this.port}. In the Studio: Help → Connect an agent, port ${this.port}, pairing token ${this.token}`);
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
          attempt = { tabNonce: msg.nonce, relayNonce, key, mode: msg.mode };
          this.sendPlain(ws, { type: 'challenge', nonce: relayNonce, proof: hmac(key, proofText('relay', this.port, msg.nonce, relayNonce)) });
          return;
        }
        if (msg.type !== 'prove') return ws.close(4001, 'prove next');
        const p = attempt;
        if (!sameSecret(msg.proof, hmac(p.key, proofText('tab', this.port, p.tabNonce, p.relayNonce))))
          return refuse(p.mode === 'resume' ? 'The resume key no longer matches: connect with the pairing token.' : 'Wrong pairing token. Copy the one the relay printed.');
        if (this.tab) return refuse('Another Studio tab is connected. Disconnect it first.');
        clearTimeout(timer);
        paired = true;
        if (p.mode === 'token') this.token = newToken(); // one-time: used up once it pairs
        // Bound to this proof: only the tab that proved it can derive them.
        this.resume = hmac(p.key, proofText('resume', this.port, p.tabNonce, p.relayNonce));
        session = hmac(p.key, proofText('session', this.port, p.tabNonce, p.relayNonce));
        this.tab = { ws, origin, session, seqOut: 0 };
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
        case 'tools':
          this.toolList = inner.tools;
          this.onToolsChanged();
          break;
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
    ws.on('close', () => {
      clearTimeout(timer);
      if (!paired) {
        // A failed or unfinished handshake that saw a proof of the token: the token is spent.
        if (attempt?.mode === 'token') {
          this.token = newToken();
          this.log('A pairing attempt failed or was not finished: the pairing token changed.');
          this.announce();
        }
        return;
      }
      if (this.tab?.ws !== ws) return;
      this.tab = null;
      this.toolList = [];
      this.failAll('The Studio tab disconnected');
      this.onToolsChanged();
      this.token = newToken();
      this.log('Studio tab disconnected (reloading the same tab reconnects by itself).');
      this.announce();
    });
  }

  private failAll(why: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(err(why));
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
