// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

import { DEFAULT_ORIGINS, DEFAULT_PORT } from './relay.js';


export const HELP = `Usage: stroq-studio-mcp [--port <n>] [--origin <url>]...

Connects any MCP client (Claude Code, Codex, Cursor, Claude Desktop…) to an open Strōq World Studio tab.

  --port <n>      Fixed WebSocket port on 127.0.0.1 (fails if busy). Default:
                  ${DEFAULT_PORT}, or any free port when that one is taken
  --origin <url>  A Studio origin allowed to connect; repeat for more. Replaces
                  the defaults (${DEFAULT_ORIGINS.join(', ')})
  --help          This text

The pairing string (port:TOKEN) is printed on stderr; paste it in the Studio under Tools → AI agent → Connect….`;

export function parseArgs(argv: string[]): { port?: number; origins: string[]; help: boolean } {
  let port: number | undefined;
  const origins: string[] = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--help' || flag === '-h') help = true;
    else if (flag === '--port') {
      const n = Number(value());
      port = n;
      if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('--port must be a whole number from 1024 to 65535');
    } else if (flag === '--origin') {
      const o = value();
      let u: URL;
      try {
        u = new URL(o);
      } catch {
        throw new Error(`--origin "${o}" is not a URL`);
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`--origin "${o}" must be http or https`);
      origins.push(u.origin);
    } else throw new Error(`Unknown option "${a}" (try --help)`);
  }
  return { port, origins: origins.length ? origins : [...DEFAULT_ORIGINS], help };
}
