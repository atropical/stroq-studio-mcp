# stroq-studio-mcp

Connects an AI agent (Claude Code, Claude Desktop or any MCP client) to an open
[Strōq World Studio](https://studio.stroq.club) tab, so the agent can build
cycling courses with the Studio's own tools: routes, road pieces, land,
landscapes, scenery, screenshots and your comments.

It is a thin relay. The MCP client starts it over stdio; it opens a WebSocket
on `127.0.0.1` that the Studio tab connects to. The tools come from the tab
itself, so they always match the Studio you have open.

```
MCP client  ⇄ stdio ⇄  stroq-studio-mcp  ⇄ ws://127.0.0.1:3021 ⇄  Studio tab
```

## Set up

### Claude Code

```sh
claude mcp add stroq-studio -- npx -y @atropical/stroq-studio-mcp
```

### Claude Desktop

Add it to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "stroq-studio": {
      "command": "npx",
      "args": ["-y", "@atropical/stroq-studio-mcp"]
    }
  }
}
```

Then restart Claude Desktop.

### Connect the Studio

1. Start your agent. The relay prints a pairing token such as `K7PQ-M3XA` on
   stderr (Claude Code: `/mcp` shows the server log). Or ask the agent to
   "connect to the Studio": its `studio_connection` tool returns the port and
   token.
2. In the Studio: **Help → Connect an agent**. Enter the port (3021) and the
   token, and switch **Connect** on. The light turns on when it is connected.
3. Ask the agent for something, e.g. "build a 10 km alpine climb with a village
   at the top".

The token works once. Reloading the same tab reconnects by itself; another tab,
or a new relay, needs a new token (the relay prints one each time a tab
disconnects).

Your browser may ask whether the Studio may reach devices on this computer or
local network: allow it, or the tab cannot reach the relay.

## Options

```
stroq-studio-mcp [--port <n>] [--origin <url>]...

  --port <n>      WebSocket port on 127.0.0.1 (default 3021)
  --origin <url>  A Studio origin allowed to connect; repeat for more. Replaces
                  the defaults (https://studio.stroq.club, http://localhost:3020)
```

With another port, use it in the MCP config too, e.g.
`claude mcp add stroq-studio -- npx -y @atropical/stroq-studio-mcp --port 3031`.

## Tools

Until a tab is connected the relay lists one tool, `studio_connection`
(connection state, port and pairing token). Once a tab connects, the tab's
tools appear (the relay sends `notifications/tools/list_changed`), for example
`list_routes`, `put_route`, `validate_route`, `scatter`, `apply_landscape`,
`screenshot` (as an image), and the comment tools `list_comments`,
`get_comment` (with its screenshot), `ack_comment`, `reply_comment`,
`resolve_comment` and `wait_for_comments`. While connected the agent owns the
Studio's comments.

## Security

- Listens on `127.0.0.1` only; nothing on your network can connect.
- Accepts a WebSocket only from an allowed `Origin` (the Studio's addresses
  above, or the ones you pass with `--origin`), so other web pages cannot use
  it.
- A tab must show the one-time pairing token first. Five wrong tokens replace
  it with a new one.
- One tab at a time.
- It stores nothing and reads no files: every tool runs inside the Studio tab,
  on the content in that browser.

## Protocol

JSON text frames over one WebSocket (see `src/protocol.ts`):

| Direction | Frame |
| --- | --- |
| tab → relay | `{ "type": "hello", "protocol": 1, "token": "K7PQ-M3XA" }` (or the resume key) |
| relay → tab | `{ "type": "welcome", "protocol": 1, "resume": "…" }` or `{ "type": "refused", "reason": "…" }` |
| tab → relay | `{ "type": "tools", "tools": [{ "name", "description", "inputSchema" }] }` |
| relay → tab | `{ "type": "call", "id": 1, "name": "list_routes", "arguments": {} }` |
| tab → relay | `{ "type": "result", "id": 1, "content": [MCP text/image blocks], "isError": false }` |
| either | `{ "type": "ping" }` / `{ "type": "pong" }` |

## Develop

```sh
bun install
bun test
npm run build      # dist/
npm run type-check
```

## Licence

Copyright (C) 2026 Atropical.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, version 3 only. It is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE).
