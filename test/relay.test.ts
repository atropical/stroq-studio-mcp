import { afterEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { parseArgs } from '../src/args.js';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_BYTES } from '../src/modelFile.js';
import { IMPORT_FILE, IMPORT_PART, macText, parseTabMessage, PROTOCOL, proofText, tokenKey } from '../src/protocol.js';
import { waitForComments } from '../src/mcp.js';
import { hmac, newToken, Relay } from '../src/relay.js';

let port = 39100 + Math.floor(Math.random() * 500);
const relays: Relay[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const r of relays.splice(0)) await r.stop();
});

async function startRelay(opts: { onToolsChanged?: () => void; graceMs?: number } = {}) {
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

  it('refuses a tab that does not know the token and takes nothing from it', async () => {
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
    expect(r.pairingToken).toBe(token);
  });

  it('keeps the token when a handshake is left unfinished (nothing local can keep breaking pairing)', async () => {
    const r = await startRelay();
    const token = r.pairingToken;
    for (let i = 0; i < 3; i++) {
      const spy = tab(r);
      await spy.open;
      spy.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', port: r.port, nonce: nonce() });
      const c = await spy.next('challenge');
      expect(JSON.stringify(c)).not.toContain(tokenKey(token));
      spy.ws.close();
      await spy.closed;
    }
    await Bun.sleep(30);
    expect(r.pairingToken).toBe(token);
    const t = tab(r);
    expect((await t.pair(tokenKey(token))).relayProved).toBe(true);
    await t.next('welcome');
  });

  it('replaces the token after five wrong proofs, at most once a minute', async () => {
    const r = await startRelay();
    const first = r.pairingToken;
    const wrong = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const t = tab(r);
        await t.pair('WRONG');
        await t.closed;
      }
    };
    await wrong(4);
    expect(r.pairingToken).toBe(first);
    await wrong(1);
    const second = r.pairingToken;
    expect(second).not.toBe(first);
    await wrong(5);
    expect(r.pairingToken).toBe(second);
  });

  it('slows token hellos after a flood of unfinished handshakes, but never resume or a correct pairing', async () => {
    const r = await startRelay();
    // A paired tab first, so there is a resume key.
    const first = tab(r);
    const { resume } = await first.pair(tokenKey(r.pairingToken));
    await first.next('welcome');
    first.ws.close();
    await first.closed;
    await Bun.sleep(30);
    // 34 hellos left unfinished.
    for (let i = 0; i < 34; i++) {
      const spy = tab(r);
      await spy.open;
      spy.send({ type: 'hello', protocol: PROTOCOL, mode: 'token', port: r.port, nonce: nonce() });
      await spy.next('challenge');
      spy.ws.close();
      await spy.closed;
    }
    await Bun.sleep(30);
    expect(r.delay()).toBe(4 * 250);
    // Resume: no wait.
    const back = tab(r);
    const t0 = Date.now();
    expect((await back.pair(resume, 'resume')).relayProved).toBe(true);
    await back.next('welcome');
    expect(Date.now() - t0).toBeLessThan(500);
    back.ws.close();
    await back.closed;
    await Bun.sleep(30);
    // A correct token pairing waits, then works, and does not count.
    const late = tab(r);
    const before = r.delay();
    const pairing = late.pair(tokenKey(r.pairingToken));
    expect(await late.next('wait')).toEqual({ type: 'wait', ms: before });
    expect((await pairing).relayProved).toBe(true);
    await late.next('welcome');
    expect(r.delay()).toBe(before);
  });

  it('caps the delay at 5 s', () => {
    const r = new Relay();
    (r as unknown as { strikes: number[] }).strikes = Array.from({ length: 500 }, () => Date.now());
    expect(r.delay()).toBe(5000);
  });

  it('uses 3021, else any free port (and says so); a fixed busy port fails', async () => {
    const lines: string[] = [];
    const holder = new Relay({ port: 3021 });
    const held = await holder.start().then(() => true, () => false); // 3021 may already be in use; either way it is taken now
    relays.push(holder);
    const r = new Relay({ log: (l) => lines.push(l) });
    relays.push(r);
    await r.start();
    expect(r.port).not.toBe(3021);
    expect(r.pairing).toBe(`${r.port}:${r.pairingToken}`);
    expect(lines.join('\n')).toContain(`Port 3021 is taken, so the relay uses port ${r.port}`);
    expect(lines.join('\n')).toContain(r.pairing);
    expect(held || true).toBe(true);
    await expect(new Relay({ port: r.port }).start()).rejects.toBeDefined();
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

  it('import_model_file: only with a tab that lists both tools; sends the file in order, in chunks, then imports it', async () => {
    const r = await startRelay();
    const t = await paired(r);
    expect(r.canImport).toBe(false);
    expect((await r.importModelFile({ path: '/x.glb' })).content[0]).toMatchObject({ text: expect.stringContaining('cannot import') });
    const schema = { type: 'object', properties: {} };
    t.seal({ type: 'tools', tools: [...TOOLS, { name: IMPORT_FILE, inputSchema: schema }, { name: IMPORT_PART, inputSchema: schema }] });
    await Bun.sleep(30);
    expect(r.canImport).toBe(true);

    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-relay-model-')));
    try {
      const bytes = Buffer.concat([Buffer.from("glTF"), randomBytes(CHUNK_BYTES * 2 + 119)]);
      writeFileSync(join(dir, 'tower.glb'), bytes);
      const p = r.importModelFile({ path: join(dir, 'tower.glb'), name: 'Tower', category: 'building', tags: ['stone'] });
      const got: Buffer[] = [];
      for (let i = 0; i < 3; i++) {
        const c = (await t.next('call')) as { id: number; name: string; arguments: { upload: string; file: string; size: number; offset: number; data: string } };
        expect(c.name).toBe(IMPORT_PART);
        expect(c.arguments).toMatchObject({ file: 'tower.glb', size: bytes.length, offset: i * CHUNK_BYTES });
        expect(c.arguments.data.length).toBeLessThan(CHUNK_BYTES * 1.4);
        got.push(Buffer.from(c.arguments.data, 'base64'));
        t.seal({ type: 'result', id: c.id, content: [{ type: 'text', text: 'ok' }] });
      }
      expect(Buffer.concat(got).equals(bytes)).toBe(true);
      const fin = (await t.next('call')) as { id: number; name: string; arguments: Record<string, unknown> };
      expect(fin).toMatchObject({ name: IMPORT_FILE, arguments: { files: [{ name: 'tower.glb', size: bytes.length }], name: 'Tower', category: 'building', tags: ['stone'] } });
      t.seal({ type: 'result', id: fin.id, content: [{ type: 'text', text: '{"id":"tower"}' }] });
      expect((await p).isError).toBe(false);

      // A refused part stops the upload; a bad path never reaches the tab.
      const q = r.importModelFile({ path: join(dir, 'tower.glb') });
      const c = (await t.next('call')) as { id: number };
      t.seal({ type: 'result', id: c.id, content: [{ type: 'text', text: 'too big' }], isError: true });
      expect(await q).toEqual({ content: [{ type: 'text', text: 'too big' }], isError: true });
      expect((await r.importModelFile({ path: '/etc/passwd' })).isError).toBe(true);

      // A low-poly version goes up as its own upload after the model, with the same checks.
      const low = Buffer.concat([Buffer.from('glTF'), randomBytes(200)]);
      writeFileSync(join(dir, 'tower_low.glb'), low);
      const lp = r.importModelFile({ path: join(dir, 'tower_low.glb'), lowPolyPath: join(dir, 'tower_low.glb') });
      const a = (await t.next('call')) as { id: number; arguments: { upload: string } };
      t.seal({ type: 'result', id: a.id, content: [{ type: 'text', text: 'ok' }] });
      const b = (await t.next('call')) as { id: number; name: string; arguments: { upload: string; data: string } };
      expect(b.name).toBe(IMPORT_PART);
      expect(b.arguments.upload).not.toBe(a.arguments.upload);
      expect(Buffer.from(b.arguments.data, 'base64').equals(low)).toBe(true);
      t.seal({ type: 'result', id: b.id, content: [{ type: 'text', text: 'ok' }] });
      const f2 = (await t.next('call')) as { id: number; arguments: Record<string, unknown> };
      expect(f2.arguments).toMatchObject({ upload: a.arguments.upload, lowPolyUpload: b.arguments.upload, lowPolyFiles: [{ name: 'tower_low.glb', size: low.length }] });
      t.seal({ type: 'result', id: f2.id, content: [{ type: 'text', text: '{}' }] });
      expect((await lp).isError).toBe(false);
      writeFileSync(join(dir, 'fake.glb'), 'nope');
      const bad = await r.importModelFile({ path: join(dir, 'tower_low.glb'), lowPolyPath: join(dir, 'fake.glb') });
      expect(bad).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Low-poly version') }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('answers pending calls with an error when the tab switches off', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++ });
    const t = await paired(r);
    const p = r.call('list_routes', {});
    await t.next('call');
    t.ws.close(1000);
    expect((await p).isError).toBe(true);
    expect(r.tools).toEqual([]);
    expect(changed).toBe(2);
  });

  it('a reload (the tab drops and resumes): keeps the tools, sends no list_changed, a call made meanwhile waits for it', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++ });
    const t = tab(r);
    const { resume } = await t.pair(tokenKey(r.pairingToken));
    await t.next('welcome');
    t.seal({ type: 'tools', tools: TOOLS });
    await Bun.sleep(30);
    const pending = r.call('list_routes', {});
    await t.next('call');
    t.ws.terminate(); // like a reload: no close frame
    const first = await pending;
    expect(first).toMatchObject({ isError: true, dropped: true });
    expect(r.tools.map((x) => x.name)).toEqual(['list_routes']);
    expect(r.status().state).toBe('reconnecting');
    const meanwhile = r.call('list_routes', {});
    await Bun.sleep(50);
    const t2 = tab(r);
    await t2.pair(resume, 'resume');
    await t2.next('welcome');
    t2.seal({ type: 'tools', tools: TOOLS });
    const c = await t2.next('call');
    t2.seal({ type: 'result', id: c.id, content: [{ type: 'text', text: '[]' }] });
    expect(await meanwhile).toEqual({ content: [{ type: 'text', text: '[]' }], isError: false });
    expect(changed).toBe(1);
    expect(r.status().state).toBe('connected');
  });

  it('a tab that does not come back within the grace period: tools go, calls fail clearly', async () => {
    let changed = 0;
    const r = await startRelay({ onToolsChanged: () => changed++, graceMs: 150 });
    const t = await paired(r);
    t.ws.terminate();
    await Bun.sleep(30);
    const res = await r.call('list_routes', {});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('did not come back');
    expect(r.tools).toEqual([]);
    expect(r.status().state).toBe('waiting');
    expect(changed).toBe(2);
  });

  it('wait_for_comments: a reload mid-wait is no error, the wait carries on in the tab that resumes', async () => {
    const WAIT = [{ name: 'wait_for_comments', inputSchema: { type: 'object' as const } }];
    const r = await startRelay();
    const t = tab(r);
    const { resume } = await t.pair(tokenKey(r.pairingToken));
    await t.next('welcome');
    t.seal({ type: 'tools', tools: WAIT });
    await Bun.sleep(30);
    const wait = waitForComments(r, { timeoutSec: 5 });
    await t.next('call');
    t.ws.terminate();
    await Bun.sleep(100);
    const t2 = tab(r);
    await t2.pair(resume, 'resume');
    await t2.next('welcome');
    t2.seal({ type: 'tools', tools: WAIT });
    const c = (await t2.next('call')) as { id: number; name: string; arguments: { timeoutSec: number } };
    expect(c.name).toBe('wait_for_comments');
    expect(c.arguments.timeoutSec).toBeLessThanOrEqual(5);
    t2.seal({ type: 'result', id: c.id, content: [{ type: 'text', text: JSON.stringify({ waiting: [{ id: 'c1' }] }) }] });
    const res = await wait;
    expect(res).not.toHaveProperty('isError', true);
    expect(JSON.parse((res.content[0] as { text: string }).text).waiting).toEqual([{ id: 'c1' }]);
  });

  it('wait_for_comments: a tab that does not come back gives a normal "call again", never an error', async () => {
    const r = await startRelay({ graceMs: 200 });
    const t = tab(r);
    await t.pair(tokenKey(r.pairingToken));
    await t.next('welcome');
    t.seal({ type: 'tools', tools: [{ name: 'wait_for_comments', inputSchema: { type: 'object' } }] });
    await Bun.sleep(30);
    const wait = waitForComments(r, { timeoutSec: 5 });
    await t.next('call');
    t.ws.terminate();
    const res = await wait;
    expect(res).not.toHaveProperty('isError', true);
    expect((res.content[0] as { text: string }).text).toContain('call wait_for_comments again');
  });

  it('says how to connect when no tab is there', async () => {
    const r = await startRelay();
    const res = await r.call('list_routes', {});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain(r.pairing);
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
    expect(parseArgs([])).toEqual({ port: undefined, origins: ['https://studio.stroq.club', 'http://localhost:3020'], help: false });
    expect(parseArgs(['--port', '4000', '--origin=http://localhost:3030/x'])).toEqual({ port: 4000, origins: ['http://localhost:3030'], help: false });
    expect(() => parseArgs(['--port', '80'])).toThrow();
    expect(() => parseArgs(['--origin', 'ftp://x'])).toThrow();
    expect(() => parseArgs(['--what'])).toThrow();
  });
});
