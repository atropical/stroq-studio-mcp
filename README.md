# stroq-studio-mcp

Connects your AI agent (any MCP client: Claude Code, Codex, Cursor, Claude
Desktop and others) to an open
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

### Codex CLI

```sh
codex mcp add stroq-studio -- npx -y @atropical/stroq-studio-mcp
```

### Claude Desktop, Cursor and other MCP clients

Add it to the client's MCP config (Claude Desktop: `claude_desktop_config.json`,
Settings → Developer → Edit Config; Cursor: `~/.cursor/mcp.json`):

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

Then restart the client.

### Connect the Studio

1. Start your agent. The relay prints one pairing code, `port:TOKEN`, such as
   `3021:ABCDE-FGHIJ-KLMNO-PQRST-UVW234`, on stderr (most clients show the
   server log). Or ask the agent to "connect to the Studio": its
   `studio_connection` tool returns it.
2. In the Studio: **Tools → AI agent → Connect…**. Paste the code and switch
   **Connect** on. The light turns on when it is connected. (A token pasted on
   its own means port 3021.)
3. Ask the agent for something, e.g. "build a 10 km alpine climb with a village
   at the top".

A code is used up once a tab pairs with it. Reloading the same tab reconnects
by itself; another tab, or a new relay, needs a new code (the relay prints one
each time a tab disconnects).

Your browser may ask whether the Studio may reach devices on this computer or
local network: allow it, or the tab cannot reach the relay.

## Options

```
stroq-studio-mcp [--port <n>] [--origin <url>]...

  --port <n>      Fixed WebSocket port on 127.0.0.1 (fails if busy). Default:
                  3021, or any free port when that one is taken (said on stderr;
                  the pairing code always carries the port)
  --origin <url>  A Studio origin allowed to connect; repeat for more. Replaces
                  the defaults (https://studio.stroq.club, http://localhost:3020)
```

No port setting is needed: the pairing code carries it. To fix one, add it to
the MCP config, e.g.
`claude mcp add stroq-studio -- npx -y @atropical/stroq-studio-mcp --port 3031`.

## Tools

Until a tab is connected the relay lists two tools, `studio_connection`
(connection state, the pairing code and what to do next) and
`wait_for_comments`. Once a tab connects, the tab's
tools appear (the relay sends `notifications/tools/list_changed`), for example
`list_routes`, `put_route`, `validate_route`, `scatter`, `apply_landscape`,
`screenshot` (as an image), and the comment tools `list_comments`,
`get_comment` (with its screenshot), `ack_comment`, `reply_comment`,
`resolve_comment` and `wait_for_comments`. While connected the agent owns the
Studio's comments.

## Watching for comments and Asks

MCP agents only act when prompted, so the relay leads them into a watch loop
through plain tool results, the same in every client. `studio_connection`
says: tell the person the pairing string, then call `wait_for_comments`.
`wait_for_comments` is handled by the relay: before pairing it waits for the
tab, then for comments and Asks, and it always returns within 45 s (under
common client tool timeouts) with what is waiting or "nothing new: call
wait_for_comments again". The server instructions say the same: ack,
get_comment, do the work, reply_comment, wait again, until the person stops it.

If an agent stops listening, the standard MCP prompt `watch_studio` (or saying
"Watch the Strōq Studio: handle every comment and Ask as it comes in, and keep
waiting for the next one.") starts the loop again.

`import_model_file` is the one tool the relay handles itself: it reads a model
from this computer (`path`, absolute; optional `name`, `category`, `tags`) and
sends it to the tab in 1 MB parts over the sealed connection; the tab imports
it into the Library the same way as the Library's own file import (optimised,
scaled, thumbnail) and answers with the new asset id and its thumbnail. It is
listed only while a connected tab offers it.

## Using it with Blender MCP

With [blender-mcp](https://github.com/ahujasid/blender-mcp) added alongside,
an agent can model something in Blender and put it straight into the Studio:

```sh
claude mcp add stroq-studio -- npx -y @atropical/stroq-studio-mcp
claude mcp add blender -- uvx blender-mcp
```

Open Blender with the blender-mcp add-on connected, connect the Studio, then
ask, for example: "Model a small stone well in Blender, export it as GLB to
/tmp/well.glb and add it to the Studio Library as a building." The agent
models it through Blender MCP, exports with
`bpy.ops.export_scene.gltf(filepath='/tmp/well.glb', export_format='GLB')`,
and calls `import_model_file` with that path. Model in metres, Z up (the glTF
exporter turns it Y up); the Studio scales it to a real height by category.

## Security

- Listens on `127.0.0.1` only; nothing on your network can connect.
- Accepts a WebSocket only from an allowed `Origin` (the Studio's addresses
  above, or the ones you pass with `--origin`), so other web pages cannot use
  it.
- The pairing token is 26 base32 characters (about 130 bits), far too many to
  guess offline from the relay's proof. Five wrong proofs replace it with a
  new one (printed on stderr), at most once a minute.
- Nothing on the machine can block pairing: once more than 30 handshakes in a
  minute have failed or been left unfinished, token hellos are answered late
  (growing, at most 5 seconds, with a `wait` frame first). Successful
  pairings never count, and resume hellos (a 256-bit key) never wait.
- Pairing is mutual and bound to the port: the tab and the relay each prove
  they know the token with an HMAC-SHA256 over two fresh nonces and the port
  the tab dialled, which the relay checks against the port it listens on. The
  token never crosses the wire, the tab trusts no other process on the port,
  and a relay in the middle on another port cannot pass the proofs on.
- After pairing every frame, both ways, carries an HMAC with the session key
  derived from the proof and a sequence number per direction; a changed,
  replayed or out-of-order frame closes the connection.
- The resume key for reloads is derived from the proof on both sides and is
  never sent.
- One tab at a time.
- It stores nothing, and every tool runs inside the Studio tab, on the content
  in that browser. The only files it reads are the ones you or your agent name
  in `import_model_file`: a `.glb`, a `.gltf` or a `.zip`, at most 100 MB in
  all. A glTF (also inside a zip) may bring only `.bin` buffers whose size
  matches their `byteLength` and PNG, JPEG, WebP or KTX2 images whose first
  bytes match their type, from its folder and at most two levels down; a zip
  holds only those and the model. It refuses relative paths, symlinks, hidden
  files or folders (a name starting with `.`) and anything whose real path is
  outside the model's folder.

## Protocol

JSON text frames over one WebSocket (see `src/protocol.ts`). The key is the
token (upper case, letters and digits) or the resume key from the last
pairing; `port` is the port the tab dialled; nonces are 32 random bytes in hex;
proofs and MACs are hex HMAC-SHA256.

| Direction | Frame |
| --- | --- |
| tab → relay | `{ "type": "hello", "protocol": 3, "mode": "token" or "resume", "port": 3021, "nonce": tn }` |
| relay → tab | `{ "type": "challenge", "nonce": rn, "proof": HMAC(key, "relay\|port\|tn\|rn") }` or `{ "type": "refused", "reason": "…" }`, maybe after `{ "type": "wait", "ms": n }` |
| tab → relay | `{ "type": "prove", "proof": HMAC(key, "tab\|port\|tn\|rn") }` (only after checking the relay's proof) |

Both then hold `session = HMAC(key, "session|port|tn|rn")` and
`resume = HMAC(key, "resume|port|tn|rn")`. Every later frame is
`{ "type": "sealed", "seq": n, "body": "<frame JSON>", "mac": HMAC(session, dir + "|" + n + "|" + body) }`,
`dir` being `relay` or `tab` and `seq` counting from 0 in each direction.
Sealed bodies:

| Direction | Body |
| --- | --- |
| relay → tab | `{ "type": "welcome", "protocol": 3 }` (the first) |
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
