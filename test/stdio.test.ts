/** The CLI end to end: an MCP client over stdio, a fake Studio tab over the WebSocket. */
import { afterAll, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { macText, PROTOCOL, proofText, tokenKey } from '../src/protocol.js';
import { hmac } from '../src/relay.js';
import { randomBytes } from 'node:crypto';

const port = 39700 + Math.floor(Math.random() * 200);
let stderr = '';
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(__dirname, '../src/cli.ts'), '--port', String(port)], stderr: 'pipe' });
transport.stderr?.on('data', (d) => {
  stderr += d.toString();
});
const client = new Client({ name: 'test', version: '1' });
let ws: WebSocket | null = null;

afterAll(async () => {
  ws?.terminate();
  await client.close();
});

it('lists studio_connection, then the tab’s tools, and relays a call', async () => {
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed++;
  });
  await client.connect(transport);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['studio_connection', 'wait_for_comments']);

  const status = JSON.parse((((await client.callTool({ name: 'studio_connection', arguments: {} })).content as { text: string }[])[0]!).text);
  expect(status.state).toBe('waiting');
  expect(stderr).toContain(status.pairing);
  expect(status.pairing).toBe(`${port}:${status.token}`);
  // The result leads a plain agent into the watch loop: wait_for_comments, before pairing.
  expect(status.next).toContain('call wait_for_comments');
  const waited = client.callTool({ name: 'wait_for_comments', arguments: {} });

  const nonce = randomBytes(32).toString('hex');
  ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://studio.stroq.club' });
  await new Promise((r) => ws!.once('open', r));
  const key = tokenKey(status.token);
  let session = '';
  let seq = 0;
  const seal = (m: unknown) => {
    const body = JSON.stringify(m);
    const s = seq++;
    ws!.send(JSON.stringify({ type: 'sealed', seq: s, body, mac: hmac(session, macText('tab', s, body)) }));
  };
  ws.on('message', (d) => {
    let m = JSON.parse(d.toString());
    if (m.type === 'challenge') {
      session = hmac(key, proofText('session', port, nonce, m.nonce));
      return ws!.send(JSON.stringify({ type: 'prove', proof: hmac(key, proofText('tab', port, nonce, m.nonce)) }));
    }
    if (m.type === 'sealed') m = JSON.parse(m.body);
    if (m.type === 'welcome')
      seal({ type: 'tools', tools: ['list_routes', 'wait_for_comments'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) });
    if (m.type === 'call' && m.name === 'wait_for_comments') {
      expect(m.arguments.timeoutSec).toBeLessThanOrEqual(45);
      seal({ type: 'result', id: m.id, content: [{ type: 'text', text: JSON.stringify({ waiting: [{ id: 'c1', type: 'ask', text: 'Hi' }] }) }] });
    } else if (m.type === 'call') seal({ type: 'result', id: m.id, content: [{ type: 'text', text: `ran ${m.name}` }] });
  });
  ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, mode: 'token', port, nonce }));

  // The wait called before pairing returns the Ask once the tab pairs, with the next step.
  const w = (await waited).content as { text: string }[];
  expect(JSON.parse(w[0]!.text).waiting[0].id).toBe('c1');
  expect(w[1]!.text).toContain('call wait_for_comments again');
  expect(JSON.parse(((await client.callTool({ name: 'studio_connection', arguments: {} })).content as { text: string }[])[0]!.text).next).toContain('wait_for_comments');

  for (let i = 0; i < 100 && !changed; i++) await Bun.sleep(20);
  expect(changed).toBeGreaterThan(0);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['studio_connection', 'wait_for_comments', 'list_routes']);
  const res = await client.callTool({ name: 'list_routes', arguments: {} });
  expect(res.content).toEqual([{ type: 'text', text: 'ran list_routes' }]);
}, 20_000);

it('offers the watch_studio prompt', async () => {
  const { prompts } = await client.listPrompts();
  expect(prompts.map((p) => p.name)).toEqual(['watch_studio']);
  const p = await client.getPrompt({ name: 'watch_studio' });
  const t = (p.messages[0]!.content as { text: string }).text;
  expect(t).toContain('wait_for_comments');
  expect(t).toContain('until the person tells you to stop');
  expect(client.getInstructions()).toContain('keep calling it in a loop');
});
