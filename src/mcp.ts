// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/** The MCP side: the tools learnt from the tab, plus studio_connection (always there). */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Relay } from './relay.js';

export const VERSION = '0.1.0';

export const CONNECTION_TOOL = {
  name: 'studio_connection',
  description:
    'Whether a Strōq World Studio tab is connected to this relay. When none is, it gives the pairing string (port:TOKEN) to tell the person: in the Studio, Tools → AI agent → Connect…, paste it, switch Connect on. The Studio tools appear once the tab connects.',
  inputSchema: { type: 'object' as const, properties: {} },
};

export const INSTRUCTIONS =
  'Tools of an open Strōq World Studio tab, relayed. If only studio_connection is listed, no tab is connected yet: call it and tell the person the pairing string (port:TOKEN) to paste under Tools → AI agent → Connect…. While connected this agent owns the Studio comments: ack_comment straight away, get_comment for the picture and thread, do the work, then reply_comment saying what changed.';

export function createMcpServer(relay: Relay): Server {
  const server = new Server({ name: 'stroq-studio', version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [CONNECTION_TOOL, ...relay.tools.filter((t) => t.name !== CONNECTION_TOOL.name)] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === CONNECTION_TOOL.name) return { content: [{ type: 'text' as const, text: JSON.stringify(relay.status(), null, 2) }] };
    return relay.call(name, (args ?? {}) as Record<string, unknown>);
  });
  return server;
}
