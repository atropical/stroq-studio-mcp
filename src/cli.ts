#!/usr/bin/env node
// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HELP, parseArgs } from './args.js';
import { createMcpServer, VERSION } from './mcp.js';
import { Relay } from './relay.js';

const log = (line: string) => process.stderr.write(`[stroq-studio] ${line}\n`);

let opts: ReturnType<typeof parseArgs>;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  log((e as Error).message);
  process.exit(2);
}
if (opts.help) {
  process.stderr.write(`stroq-studio-mcp ${VERSION}\n${HELP}\n`);
  process.exit(0);
}

let live = false;
const relay = new Relay({
  port: opts.port,
  origins: opts.origins,
  log,
  onToolsChanged: () => {
    if (live) server.sendToolListChanged().catch(() => undefined);
  },
});
const server = createMcpServer(relay);
server.oninitialized = () => {
  live = true;
};

try {
  await relay.start();
} catch (e) {
  log(`Could not listen on 127.0.0.1:${opts.port ?? relay.port}: ${(e as Error).message}.${opts.port ? ' Is another relay running on it? Pick another --port, or leave --port out to use any free port.' : ''}`);
  process.exit(1);
}
await server.connect(new StdioServerTransport());

const stop = () => {
  relay.stop().finally(() => process.exit(0));
};
process.stdin.on('close', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
