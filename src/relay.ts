// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/**
 * The WebSocket side: one Studio tab at a time, on 127.0.0.1 only, from an
 * allowed Origin only, after it shows the pairing token (or the resume key
 * it got when it paired, so a reload reconnects without a new token).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Content, MAX_FRAME, PROTOCOL, parseTabMessage, type RelayMessage, type ToolInfo } from './protocol.js';

export const DEFAULT_PORT = 3021;
export const DEFAULT_ORIGINS = ['https://studio.stroq.club', 'http://localhost:3020'];
/** Wrong tokens before the pairing token is replaced by a new one. */
const MAX_WRONG = 5;
/** The tab must say hello within this time. */
const HELLO_MS = 10_000;
/** Longest a tool call may take (wait_for_comments waits up to 10 min). */
export const CALL_TIMEOUT_MS = 11 * 60_000;

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** An 8-character token, e.g. K7PQ-M3XA (no 0/O, 1/I/L, U). */
export function newToken(): string {
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i]! % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const normalise = (t: string) => t.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

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
  private wrong = 0;
  private tab: { ws: WebSocket; origin: string } | null = null;
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
    const helloTimer = setTimeout(() => {
      if (!paired) ws.close(4000, 'no hello');
    }, HELLO_MS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4002, 'text frames only');
      const msg = parseTabMessage(data.toString());
      if (!msg) return;
      if (!paired) {
        if (msg.type !== 'hello') return ws.close(4001, 'hello first');
        clearTimeout(helloTimer);
        const why = this.pair(msg.protocol, msg.token);
        if (why) {
          this.send(ws, { type: 'refused', reason: why });
          return ws.close(4003, 'refused');
        }
        paired = true;
        this.resume = randomBytes(24).toString('hex');
        this.tab = { ws, origin };
        this.send(ws, { type: 'welcome', protocol: PROTOCOL, resume: this.resume });
        this.log(`Studio tab connected (${origin})`);
        return;
      }
      switch (msg.type) {
        case 'tools':
          this.toolList = msg.tools;
          this.onToolsChanged();
          break;
        case 'result': {
          const p = this.pending.get(msg.id);
          if (!p) break;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve({ content: msg.content, isError: !!msg.isError });
          break;
        }
        case 'ping':
          this.send(ws, { type: 'pong' });
          break;
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
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

  /** Why a hello is refused, or null when it pairs. */
  private pair(protocol: number, token: string): string | null {
    if (protocol !== PROTOCOL) return `This relay speaks protocol ${PROTOCOL}, the Studio ${protocol}: update @atropical/stroq-studio-mcp`;
    if (this.tab) return 'Another Studio tab is connected. Disconnect it first.';
    if (this.resume && sameSecret(token, this.resume)) return null;
    if (sameSecret(normalise(token), normalise(this.token))) {
      this.wrong = 0;
      this.token = newToken(); // one-time: used up once it pairs
      return null;
    }
    this.wrong++;
    if (this.wrong >= MAX_WRONG) {
      this.wrong = 0;
      this.token = newToken();
      this.log('Too many wrong tokens: the pairing token changed.');
      this.announce();
    }
    return 'Wrong pairing token. Copy the one the relay printed.';
  }

  private failAll(why: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(err(why));
      this.pending.delete(id);
    }
  }

  private send(ws: WebSocket, m: RelayMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  }
}

const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
