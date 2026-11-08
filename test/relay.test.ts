import { afterEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { parseArgs } from '../src/args.js';
import { parseTabMessage, PROTOCOL, proofText, tokenKey } from '../src/protocol.js';
import { hmac, newToken, Relay } from '../src/relay.js';

let port = 39100 + Math.floor(Math.random() * 500);
const relays: Relay[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const r of relays.splice(0)) await r.stop();
});

async function startRelay(opts: { onToolsChanged?: () => void } = {}) {
  const r = new Relay({ port: ++port, ...opts });
  relays.push(r);
  await r.start();
  return r;
}

/** A fake Studio tab: frames it got, in order. */
function tab(r: Relay, origin = 'http://localhost:3020') {
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}`, { origin });
  sockets.push(ws);
  const got: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    got.push(JSON.parse(d.toString()));
    for (const w of waiters.splice(0)) w();
  });
  const next = async (type: string) => {
    for (;;) {
      const i = got.findIndex((m) => m.type === type);
      if (i >= 0) return got.splice(i, 1)[0]!;
      await new Promise<void>((res) => waiters.push(res));
    }
  };
  const open = new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  const closed = new Promise<number>((res) => ws.once('close', (code) => res(code)));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  /** The tab's side of the handshake with this key; returns the derived resume key and whether the relay proved itself. */
  const pair = async (key: string, mode: 'token' | 'resume' = 'token') => {
    await open;
    const tabNonce = randomBytes(32).toString('hex');
    send({ type: 'hello', protocol: PROTOCOL, mode, nonce: tabNonce });
    const c = (await next('challenge')) as { nonce: string; proof: string };
    const relayProved = c.proof === hmac(key, proofText('relay', tabNonce, c.nonce));
    send({ type: 'prove', proof: hmac(key, proofText('tab', tabNonce, c.nonce)) });
    return { relayProved, resume: hmac(key, proofText('resume', tabNonce, c.nonce)) };
  };
  return { ws, open, closed, next, send, pair };
}

const TOOLS = [{ name: 'list_routes', description: 'List routes', inputSchema: { type: 'object', properties: {} } }];

describe('pairing', () => {
  it('refuses an origin that is not allowed', async () => {
    const r = await startRelay();
    const t = tab(r, 'https://evil.example');
    await expect(t.open).rejects.toBeDefined();
  });

  it('refuses a tab that does not know the token, and takes nothing from it', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++ });
    const t = tab(r);
    const { relayProved } = await t.pair('AAAAAAAA');
    expect(relayProved).toBe(false);
    t.send({ type: 'tools', tools: TOOLS });
    expect((await t.next('refused')).reason).toContain('Wrong pairing token');
    expect(await t.closed).toBe(4003);
    expect(changed).toBe(0);
    expect(r.status().state).toBe('waiting');
  });

  it('never sends the token, and closes a tab that skips the proof', async () => {
    const r = await startRelay();
    const t = tab(r);
    await t.open;
    t.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', nonce: randomBytes(32).toString('hex') });
    const c = await t.next('challenge');
    expect(JSON.stringify(c)).not.toContain(tokenKey(r.pairingToken));
    t.send({ type: 'tools', tools: TOOLS });
    expect(await t.closed).toBe(4001);
    expect(r.tools).toEqual([]);
  });

  it('pairs both ways with the token (any case, with or without the dash), once', async () => {
    const r = await startRelay();
    const token = r.pairingToken;
    const t = tab(r);
    const { relayProved, resume } = await t.pair(tokenKey(token.toLowerCase()));
    expect(relayProved).toBe(true);
    const w = await t.next('welcome');
    expect(w).toEqual({ type: 'welcome', protocol: PROTOCOL });
    expect(r.status().state).toBe('connected');
    expect(r.pairingToken).not.toBe(token);

    // one tab at a time
    const t2 = tab(r);
    await t2.open;
    t2.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', nonce: randomBytes(32).toString('hex') });
    expect((await t2.next('refused')).reason).toContain('Another Studio tab');

    // after it leaves, the old token no longer works but the derived resume key does
    t.ws.close();
    await t.closed;
    await Bun.sleep(30);
    const t3 = tab(r);
    await t3.pair(tokenKey(token));
    await t3.next('refused');
    const t4 = tab(r);
    expect((await t4.pair(resume, 'resume')).relayProved).toBe(true);
    await t4.next('welcome');
  });

  it('changes the token after five wrong tries', async () => {
    const r = await startRelay();
    const first = r.pairingToken;
    for (let i = 0; i < 5; i++) {
      const t = tab(r);
      await t.pair('WRONG');
      await t.closed;
    }
    expect(r.pairingToken).not.toBe(first);
  });

  it('refuses another protocol version', async () => {
    const r = await startRelay();
    const t = tab(r);
    await t.open;
    t.send({ type: 'hello', protocol: 1, token: r.pairingToken });
    expect((await t.next('refused')).reason).toContain('protocol');
  });
});

async function paired(r: Relay) {
  const t = tab(r);
  await t.pair(tokenKey(r.pairingToken));
  await t.next('welcome');
  t.send({ type: 'tools', tools: TOOLS });
  await Bun.sleep(30);
  return t;
}

describe('calls', () => {
  it('learns the tools and relays a call with its answer', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++ });
    const t = await paired(r);
    expect(changed).toBe(1);
    expect(r.tools.map((x) => x.name)).toEqual(['list_routes']);

    const p = r.call('list_routes', {});
    const c = await t.next('call');
    expect(c).toMatchObject({ name: 'list_routes', arguments: {} });
    t.send({ type: 'result', id: c.id, content: [{ type: 'text', text: '[]' }] });
    expect(await p).toEqual({ content: [{ type: 'text', text: '[]' }], isError: false });

    expect((await r.call('nope', {})).isError).toBe(true);
  });

  it('answers pending calls with an error when the tab goes', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++ });
    const t = await paired(r);
    const p = r.call('list_routes', {});
    await t.next('call');
    t.ws.close();
    const res = await p;
    expect(res.isError).toBe(true);
    expect(r.tools).toEqual([]);
    expect(changed).toBe(2);
  });

  it('says how to connect when no tab is there', async () => {
    const r = await startRelay();
    const res = await r.call('list_routes', {});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain(r.pairingToken);
  });
});

describe('frames and flags', () => {
  it('drops malformed frames', () => {
    expect(parseTabMessage('nope')).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'hello', protocol: PROTOCOL, mode: 'token', nonce: 'short' }))).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'prove', proof: 'x' }))).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'tools', tools: [{ name: 'bad name!', inputSchema: { type: 'object' } }] }))).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'result', id: 1, content: [{ type: 'image', data: 'x', mimeType: 'text/html' }] }))).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'result', id: 1, content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }))).not.toBeNull();
  });

  it('makes readable tokens', () => {
    for (let i = 0; i < 50; i++) expect(newToken()).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
  });

  it('parses --port and --origin', () => {
    expect(parseArgs([])).toEqual({ port: 3021, origins: ['https://studio.stroq.club', 'http://localhost:3020'], help: false });
    expect(parseArgs(['--port', '4000', '--origin=http://localhost:3030/x'])).toEqual({ port: 4000, origins: ['http://localhost:3030'], help: false });
    expect(() => parseArgs(['--port', '80'])).toThrow();
    expect(() => parseArgs(['--origin', 'ftp://x'])).toThrow();
    expect(() => parseArgs(['--what'])).toThrow();
  });
});
