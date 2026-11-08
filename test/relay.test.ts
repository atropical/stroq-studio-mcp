import { afterEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { parseArgs } from '../src/args.js';
import { macText, parseTabMessage, PROTOCOL, proofText, tokenKey } from '../src/protocol.js';
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

const nonce = () => randomBytes(32).toString('hex');

/** A fake Studio tab: frames it got, in order (sealed ones opened and checked). */
function tab(r: Relay, origin = 'http://localhost:3020') {
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}`, { origin });
  sockets.push(ws);
  const got: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let session = '';
  let seqIn = 0;
  let seqOut = 0;
  ws.on('message', (d) => {
    let m = JSON.parse(d.toString());
    if (m.type === 'sealed') {
      expect(m.seq).toBe(seqIn++);
      expect(m.mac).toBe(hmac(session, macText('relay', m.seq, m.body)));
      m = JSON.parse(m.body);
    }
    got.push(m);
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
  const sealedFrame = (m: unknown, seq = seqOut++) => {
    const body = JSON.stringify(m);
    return { type: 'sealed', seq, body, mac: hmac(session, macText('tab', seq, body)) };
  };
  const seal = (m: unknown) => send(sealedFrame(m));
  /** The tab's side of the handshake with this key; returns whether the relay proved itself, and the resume key. */
  const pair = async (key: string, mode: 'token' | 'resume' = 'token', dialled = r.port) => {
    await open;
    const tn = nonce();
    send({ type: 'hello', protocol: PROTOCOL, mode, port: dialled, nonce: tn });
    const c = (await next('challenge')) as { nonce: string; proof: string };
    const relayProved = c.proof === hmac(key, proofText('relay', dialled, tn, c.nonce));
    session = hmac(key, proofText('session', dialled, tn, c.nonce));
    send({ type: 'prove', proof: hmac(key, proofText('tab', dialled, tn, c.nonce)) });
    return { relayProved, resume: hmac(key, proofText('resume', dialled, tn, c.nonce)), challenge: c, tn };
  };
  return { ws, open, closed, next, send, seal, sealedFrame, pair };
}

const TOOLS = [{ name: 'list_routes', description: 'List routes', inputSchema: { type: 'object', properties: {} } }];

describe('pairing', () => {
  it('refuses an origin that is not allowed', async () => {
    const r = await startRelay();
    const t = tab(r, 'https://evil.example');
    await expect(t.open).rejects.toBeDefined();
  });

  it('refuses a tab that does not know the token, takes nothing from it, and spends the token', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++ });
    const token = r.pairingToken;
    const t = tab(r);
    const { relayProved } = await t.pair('AAAAAAAA');
    expect(relayProved).toBe(false);
    expect((await t.next('refused')).reason).toContain('Wrong pairing token');
    expect(await t.closed).toBe(4003);
    expect(changed).toBe(0);
    expect(r.status().state).toBe('waiting');
    expect(r.pairingToken).not.toBe(token);
  });

  it('gives no offline oracle: a proof seen by an unfinished handshake is for a token already replaced', async () => {
    const r = await startRelay();
    const token = r.pairingToken;
    const spy = tab(r);
    await spy.open;
    const tn = nonce();
    spy.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', port: r.port, nonce: tn });
    const c = (await spy.next('challenge')) as { nonce: string; proof: string };
    // The relay's proof is of the current token…
    expect(c.proof).toBe(hmac(tokenKey(token), proofText('relay', r.port, tn, c.nonce)));
    expect(JSON.stringify(c)).not.toContain(tokenKey(token));
    // …but walking away spends it: guessing it offline gains nothing.
    spy.ws.close();
    await spy.closed;
    await Bun.sleep(30);
    expect(r.pairingToken).not.toBe(token);
    const late = tab(r);
    expect((await late.pair(tokenKey(token))).relayProved).toBe(false);
    await late.next('refused');
  });

  it('makes 130-bit tokens grouped for pasting', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = newToken();
      expect(t).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{6}$/);
      expect(tokenKey(t)).toHaveLength(26);
      seen.add(t);
    }
    expect(seen.size).toBe(50);
  });

  it('refuses a hello for another port (a relay in the middle), and its proofs would not match', async () => {
    const r = await startRelay();
    const token = r.pairingToken;
    const t = tab(r);
    await t.open;
    t.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', port: r.port + 1, nonce: nonce() });
    expect((await t.next('refused')).reason).toContain(`port ${r.port}`);
    // A tab that dialled another port computes other proofs: the real relay's proof fails it.
    const t2 = tab(r);
    await t2.open;
    const tn = nonce();
    t2.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', port: r.port, nonce: tn });
    const c = (await t2.next('challenge')) as { nonce: string; proof: string };
    const key = tokenKey(r.pairingToken);
    expect(c.proof).not.toBe(hmac(key, proofText('relay', r.port + 1, tn, c.nonce)));
  });

  it('closes a tab that skips the proof', async () => {
    const r = await startRelay();
    const t = tab(r);
    await t.open;
    t.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', port: r.port, nonce: nonce() });
    await t.next('challenge');
    t.send({ type: 'tools', tools: TOOLS });
    expect(await t.closed).toBe(4001);
    expect(r.tools).toEqual([]);
  });

  it('pairs both ways with the token (any case, with or without dashes), once; resume works', async () => {
    const r = await startRelay();
    const token = r.pairingToken;
    const t = tab(r);
    const { relayProved, resume } = await t.pair(tokenKey(token.toLowerCase()));
    expect(relayProved).toBe(true);
    expect(await t.next('welcome')).toEqual({ type: 'welcome', protocol: PROTOCOL });
    expect(r.status().state).toBe('connected');
    expect(r.pairingToken).not.toBe(token);

    const t2 = tab(r);
    await t2.open;
    t2.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', port: r.port, nonce: nonce() });
    expect((await t2.next('refused')).reason).toContain('Another Studio tab');

    t.ws.close();
    await t.closed;
    await Bun.sleep(30);
    const t3 = tab(r);
    expect((await t3.pair(resume, 'resume')).relayProved).toBe(true);
    await t3.next('welcome');
  });

  it('refuses another protocol version', async () => {
    const r = await startRelay();
    const t = tab(r);
    await t.open;
    t.send({ type: 'hello', protocol: 2, mode: 'token', nonce: nonce() });
    expect((await t.next('refused')).reason).toContain('protocol');
  });
});

async function paired(r: Relay) {
  const t = tab(r);
  await t.pair(tokenKey(r.pairingToken));
  await t.next('welcome');
  t.seal({ type: 'tools', tools: TOOLS });
  await Bun.sleep(30);
  return t;
}

describe('sealed frames', () => {
  it('learns the tools and relays a call with its answer', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++ });
    const t = await paired(r);
    expect(changed).toBe(1);
    expect(r.tools.map((x) => x.name)).toEqual(['list_routes']);

    const p = r.call('list_routes', {});
    const c = await t.next('call');
    expect(c).toMatchObject({ name: 'list_routes', arguments: {} });
    t.seal({ type: 'result', id: c.id, content: [{ type: 'text', text: '[]' }] });
    expect(await p).toEqual({ content: [{ type: 'text', text: '[]' }], isError: false });
    expect((await r.call('nope', {})).isError).toBe(true);
  });

  it('closes on a tampered frame', async () => {
    const r = await startRelay();
    const t = await paired(r);
    const f = t.sealedFrame({ type: 'tools', tools: [] });
    t.send({ ...f, body: JSON.stringify({ type: 'tools', tools: TOOLS.concat(TOOLS.map((x) => ({ ...x, name: 'evil' }))) }) });
    expect(await t.closed).toBe(4004);
    expect(r.tools).toEqual([]);
  });

  it('closes on a replayed frame', async () => {
    const r = await startRelay();
    const t = await paired(r);
    const f = t.sealedFrame({ type: 'ping' });
    t.send(f);
    await t.next('pong');
    t.send(f);
    expect(await t.closed).toBe(4004);
  });

  it('closes on an unsealed frame after pairing', async () => {
    const r = await startRelay();
    const t = await paired(r);
    t.send({ type: 'tools', tools: TOOLS });
    expect(await t.closed).toBe(4004);
  });

  it('answers pending calls with an error when the tab goes', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++ });
    const t = await paired(r);
    const p = r.call('list_routes', {});
    await t.next('call');
    t.ws.close();
    expect((await p).isError).toBe(true);
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
    expect(parseTabMessage(JSON.stringify({ type: 'hello', protocol: PROTOCOL, mode: 'token', port: 1, nonce: 'short' }))).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'sealed', seq: -1, body: '{}', mac: 'a'.repeat(64) }))).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'prove', proof: 'x' }))).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'tools', tools: [{ name: 'bad name!', inputSchema: { type: 'object' } }] }))).toBeNull();
    expect(parseTabMessage(JSON.stringify({ type: 'result', id: 1, content: [{ type: 'image', data: 'x', mimeType: 'text/html' }] }))).toBeNull();
  });

  it('parses --port and --origin', () => {
    expect(parseArgs([])).toEqual({ port: 3021, origins: ['https://studio.stroq.club', 'http://localhost:3020'], help: false });
    expect(parseArgs(['--port', '4000', '--origin=http://localhost:3030/x'])).toEqual({ port: 4000, origins: ['http://localhost:3030'], help: false });
    expect(() => parseArgs(['--port', '80'])).toThrow();
    expect(() => parseArgs(['--origin', 'ftp://x'])).toThrow();
    expect(() => parseArgs(['--what'])).toThrow();
  });
});
