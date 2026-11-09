// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/** The MCP side: the tools learnt from the tab, plus studio_connection (always there). */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MAX_MODEL_BYTES } from './modelFile.js';
import { IMPORT_FILE, IMPORT_PART } from './protocol.js';
import type { Relay } from './relay.js';

export const VERSION = '0.1.0';

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

const HIDDEN = new Set([CONNECTION_TOOL.name, IMPORT_FILE, IMPORT_PART]);

export const INSTRUCTIONS =
  'Tools of an open Strōq World Studio tab, relayed. If only studio_connection is listed, no tab is connected yet: call it and tell the person the pairing string (port:TOKEN) to paste under Tools → AI agent → Connect…. While connected this agent owns the Studio comments: ack_comment straight away, get_comment for the picture and thread, do the work, then reply_comment saying what changed.';

export function createMcpServer(relay: Relay): Server {
  const server = new Server({ name: 'stroq-studio', version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [CONNECTION_TOOL, ...relay.tools.filter((t) => !HIDDEN.has(t.name)), ...(relay.canImport ? [IMPORT_TOOL] : [])] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === CONNECTION_TOOL.name) return { content: [{ type: 'text' as const, text: JSON.stringify(relay.status(), null, 2) }] };
    if (name === IMPORT_FILE) return relay.importModelFile((args ?? {}) as Record<string, unknown>);
    if (name === IMPORT_PART) return { content: [{ type: 'text' as const, text: `Use ${IMPORT_FILE}` }], isError: true };
    return relay.call(name, (args ?? {}) as Record<string, unknown>);
  });
  return server;
}
