/** The CLI end to end: an MCP client over stdio, a fake Studio tab over the WebSocket. */
import { afterAll, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { PROTOCOL, proofText, tokenKey } from '../src/protocol.js';
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
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['studio_connection']);

  const status = JSON.parse((((await client.callTool({ name: 'studio_connection', arguments: {} })).content as { text: string }[])[0]!).text);
  expect(status.state).toBe('waiting');
  expect(stderr).toContain(status.token);

  const nonce = randomBytes(32).toString('hex');
  ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://studio.stroq.club' });
  await new Promise((r) => ws!.once('open', r));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'challenge') ws!.send(JSON.stringify({ type: 'prove', proof: hmac(tokenKey(status.token), proofText('tab', nonce, m.nonce)) }));
    if (m.type === 'welcome') ws!.send(JSON.stringify({ type: 'tools', tools: [{ name: 'list_routes', description: 'List routes', inputSchema: { type: 'object', properties: {} } }] }));
    if (m.type === 'call') ws!.send(JSON.stringify({ type: 'result', id: m.id, content: [{ type: 'text', text: `ran ${m.name}` }] }));
  });
  ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, mode: 'token', nonce }));

  for (let i = 0; i < 100 && !changed; i++) await Bun.sleep(20);
  expect(changed).toBeGreaterThan(0);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['studio_connection', 'list_routes']);
  const res = await client.callTool({ name: 'list_routes', arguments: {} });
  expect(res.content).toEqual([{ type: 'text', text: 'ran list_routes' }]);
}, 20_000);
