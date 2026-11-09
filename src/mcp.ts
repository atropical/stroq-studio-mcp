// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/** The MCP side: the tools learnt from the tab, plus studio_connection (always there). */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MAX_MODEL_BYTES } from './modelFile.js';
import { IMPORT_FILE, IMPORT_PART } from './protocol.js';
import type { Relay } from './relay.js';
import { createRequire } from 'node:module';

/** From package.json (one folder up from src/ and dist/), so it never drifts from the published version. */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export const CONNECTION_TOOL = {
  name: 'studio_connection',
  description:
    'Whether a Strōq World Studio tab is connected to this relay. When none is, it gives the pairing string (port:TOKEN) to tell the person: in the Studio, Tools → AI agent → Connect…, paste it, switch Connect on. The Studio tools appear once the tab connects.',
  inputSchema: { type: 'object' as const, properties: {} },
};

/** Handled here, not passed through: the relay reads the file and sends it to the tab in parts. */
export const IMPORT_TOOL = {
  name: IMPORT_FILE,
  description: `Adds a model file from this computer to the Studio Library (optimised, scaled, with a thumbnail). For a model made in Blender: export it as GLB (File → Export → glTF 2.0, format glb) to an absolute path, then call this. Takes .glb, .gltf (its buffers and textures from the same folder) or .zip, up to ${MAX_MODEL_BYTES / 1048576} MB; no symlinks. Returns the new asset id and its thumbnail.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Absolute path of the .glb, .gltf or .zip' },
      name: { type: 'string', description: 'Name in the Library (default: from the file name)' },
      category: { type: 'string', enum: ['prop', 'plant', 'rock', 'tree', 'building', 'vehicle', 'character'], description: 'Library category (default prop)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Search tags' },
    },
    required: ['path'],
  },
};

/** The watch loop, said the same way everywhere (tool results, instructions, the prompt). */
export const LOOP =
  'Call wait_for_comments, and keep calling it in a loop: each call returns within about 50 s, either with the comments and Asks waiting (for each: ack_comment straight away, get_comment for the picture and thread, do the work, reply_comment saying what changed) or with "nothing new", and then you call it again. Keep looping until the person tells you to stop.';

/** Longest one wait_for_comments call may take, so it returns before common client tool timeouts (~60 s). */
export const WAIT_MAX_S = 45;

/** Handled here: waits for the tab to pair, then passes the rest of the wait to the tab's own wait_for_comments. */
export const WAIT_TOOL = {
  name: 'wait_for_comments',
  description: `Waits for comments and Asks from the person in the Studio and returns them; works before the tab has paired too (it waits for the pairing first). Returns within ${WAIT_MAX_S} s; "nothing new" means call it again. Use it as a loop: handle each one (ack_comment, get_comment, do the work, reply_comment), then call wait_for_comments again, until the person stops you.`,
  inputSchema: { type: 'object' as const, properties: { timeoutSec: { type: 'integer', minimum: 1, maximum: WAIT_MAX_S, description: `Seconds to wait (default and max ${WAIT_MAX_S})` } } },
};

export const WATCH_PROMPT = {
  name: 'watch_studio',
  description: 'Watch the Strōq Studio: handle every comment and Ask as it comes in, and keep waiting for the next one.',
};
export const WATCH_TEXT = `Watch the Strōq Studio: handle every comment and Ask as it comes in, and keep waiting for the next one. ${LOOP} If the Studio is not paired yet, call studio_connection first and tell the person the pairing string.`;

const HIDDEN = new Set([CONNECTION_TOOL.name, IMPORT_FILE, IMPORT_PART, WAIT_TOOL.name]);

export const INSTRUCTIONS = `Tools of an open Strōq World Studio tab, relayed. If no tab is connected yet, call studio_connection and tell the person the pairing string (port:TOKEN) to paste under Tools → AI agent → Connect…. This agent owns the Studio's comments and Asks, and the person expects answers without prompting you again: ${LOOP}`;

const text = (t: string) => ({ type: 'text' as const, text: t });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** studio_connection: the status, plus what to do next (always: the watch loop). */
export function connectionResult(relay: Relay) {
  const s = relay.status();
  const next =
    s.state === 'waiting'
      ? `Tell the person this pairing string (${s.pairing}) to paste under Tools → AI agent → Connect…, then call wait_for_comments: it waits for the tab to pair and then for comments and Asks. ${LOOP}`
      : `Paired. ${LOOP}`;
  return { content: [text(JSON.stringify({ ...s, next }, null, 2))] };
}

/** wait_for_comments: waits for pairing, then for comments; always back within maxS. */
export async function waitForComments(relay: Relay, args: Record<string, unknown>, maxS = WAIT_MAX_S) {
  const asked = typeof args.timeoutSec === 'number' && args.timeoutSec > 0 ? args.timeoutSec : maxS;
  const until = Date.now() + Math.min(asked, maxS) * 1000;
  const ready = () => relay.tools.some((t) => t.name === WAIT_TOOL.name);
  while (!ready() && Date.now() < until) await sleep(100);
  if (!ready()) return { content: [text(JSON.stringify({ waiting: [], paired: false, next: 'The Studio has not paired yet: call wait_for_comments again.' }))] };
  const left = Math.max(1, Math.floor((until - Date.now()) / 1000));
  const r = await relay.call(WAIT_TOOL.name, { timeoutSec: left });
  if (r.isError) return r;
  let none = false;
  try {
    const v = JSON.parse(r.content[0]?.type === 'text' ? r.content[0].text : '');
    none = Array.isArray(v.waiting) && v.waiting.length === 0;
  } catch {}
  return { content: [...r.content, text(none ? 'Nothing new: call wait_for_comments again.' : 'Handle each one (ack_comment, get_comment, do the work, reply_comment), then call wait_for_comments again.')] };
}

export function createMcpServer(relay: Relay, opts: { waitMaxS?: number } = {}): Server {
  const server = new Server({ name: 'stroq-studio', version: VERSION }, { capabilities: { tools: { listChanged: true }, prompts: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [WATCH_PROMPT] }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== WATCH_PROMPT.name) throw new Error(`No prompt "${req.params.name}"`);
    return { description: WATCH_PROMPT.description, messages: [{ role: 'user' as const, content: text(WATCH_TEXT) }] };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [CONNECTION_TOOL, WAIT_TOOL, ...relay.tools.filter((t) => !HIDDEN.has(t.name)), ...(relay.canImport ? [IMPORT_TOOL] : [])] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === CONNECTION_TOOL.name) return connectionResult(relay);
    if (name === WAIT_TOOL.name) return waitForComments(relay, (args ?? {}) as Record<string, unknown>, opts.waitMaxS);
    if (name === IMPORT_FILE) return relay.importModelFile((args ?? {}) as Record<string, unknown>);
    if (name === IMPORT_PART) return { content: [{ type: 'text' as const, text: `Use ${IMPORT_FILE}` }], isError: true };
    return relay.call(name, (args ?? {}) as Record<string, unknown>);
  });
  return server;
}
