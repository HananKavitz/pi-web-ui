# pi-web-ui

A web chat interface for the [pi coding agent](https://pi.dev), built directly on
the **pi SDK** ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) —
no subprocess, no JSON-RPC shim. The agent runs in the server process and streams
events to the browser over WebSocket.

Inspired by [Pintra (pi-vsc)](https://github.com/bilalbentoumi/pi-vsc), which does
the same thing inside VS Code by spawning `pi --mode rpc`. This project instead
uses the SDK's `createAgentSessionRuntime` API in-process (the SDK docs recommend
this over RPC for Node.js apps), so you get type safety, direct state access, and
your existing pi auth/config/extensions — nothing extra to install or configure.

## Features

- 🧠 Full agent loop with **thinking** blocks (collapsible) and streaming text
- 🛠 Tool execution cards with **live output streaming**, status (queued → running → done/error), and copyable arguments
- 💬 Session **history persisted per browser** (localStorage clientId + per-client session dirs) — refresh or restart and your chats come back. The conversation panel also lists the pi CLI/TUI sessions for the current folder (tagged `TUI`), so you can resume a terminal conversation from the web UI
- 🔄 Model & thinking-level cycling (same as pi's TUI), new chat, abort/stop
- 📎 Markdown rendering with GFM tables, syntax-highlighted code blocks and copy buttons
- 📁 Workspace-aware: the agent reads/edits/runs code in a configurable directory using **your** `~/.pi/agent` auth, models, skills and extensions
- 🌐 Multiple browser clients each get an isolated session (private session dir per clientId)
- 🖥 Built-in **terminal** (xterm.js + node-pty, no VS Code needed): three panes — a
  **command list** on the left (user-defined commands with `${pwd}` support, persisted in
  the project's `.pi/commands.json`), the **terminal** in the middle, and a VSCode-style
  **tab strip** on the right for multiple concurrent shells. Switch between chat and
  terminal views with the toggle in the top bar.

## Quick start

Requires Node.js ≥ 20.11 and a configured pi install (run `pi` once to log in).

```bash
npm install
npm run dev          # server on :8787, web UI on :5173 (auto-proxied)
# open http://localhost:5173
```

Production:

```bash
npm run build        # compiles server (tsc) + frontend (vite)
npm start            # serves everything on http://localhost:8787
```

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | HTTP/WebSocket port |
| `PI_WEB_CWD` | server's cwd | The workspace directory the agent operates in (read/edit/bash/write) |
| `PI_WEB_DATA_DIR` | `<cwd>/.pi-web` | Where per-client session dirs are stored |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB) | Text attachments at or below this size are inlined into the model context; larger files are passed as path references and the model reads them on demand (saves tokens for small edits) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi config dir (auth.json, models.json, skills, extensions) |

Example — point the agent at a project:

```bash
PI_WEB_CWD=/path/to/your/project npm run dev
```

## Architecture

```text
Browser (React + Vite)
   │  WebSocket JSON — snapshot-driven protocol (server/protocol.ts)
   ▼
server/index.ts        express static + ws endpoint
   │
server/agent-service.ts   per-client ClientSession:
   │   createAgentSessionRuntime({ sessionManager: SessionManager.continueRecent(cwd, sessionDir) })
   │   session.subscribe(events) → throttled full-state snapshots + live tool deltas
   ▼
@earendil-works/pi-coding-agent (SDK, in-process)
   │   ModelRuntime (auth from ~/.pi/agent) · tools · extensions · skills
   ▼
   your LLM provider
```

Key design points:

- **Snapshot-driven UI.** The server is the source of truth: after every SDK
  event it schedules a throttled (60 ms) full-state snapshot, and the browser
  renders purely from snapshots. Reconnects just re-request `get_state`. Large
  payloads (tool output, text) are capped during serialization (`server/serialize.ts`).
- **Size-aware attachments.** Clicking + on a file queues it as an attachment
  (shown as chips above the input). On send, the server attaches each file as an
  independent custom message (SDK `sendCustomMessage` + `nextTurn` asides) — the
  user message stays clean, and each file renders as its own collapsible card:
  small text files (≤ `PI_WEB_INLINE_FILE_MAX`, default 12KB) are inlined so the
  model sees them immediately; larger files are passed as a `<file path=...>`
  reference and the model reads them on demand with its `read` tool, so attaching
  a 5 MB file costs only a few tokens until the model actually looks at it.
  Images are always attached as image content.
- **Live tool output.** `bash_execution_update` / `tool_execution_update` events
  are forwarded as lightweight `tool_delta` messages so terminal output streams
  in real time; the final output arrives in the toolResult message on the next
  snapshot, which supersedes the delta buffer.
- **Isolated sessions.** Each browser client gets `sessions/<clientId>/` under
  the data dir, resumed on reconnect via `SessionManager.continueRecent`.
- **Everything you already have.** No separate auth step — the SDK reads
  `~/.pi/agent/auth.json` and loads your global extensions/skills automatically.

## Terminal

Toggle the terminal view from the top bar (对话/终端). It replaces the chat layout
with three panes:

- **Left — 命令 (commands)**: click a command to open a terminal tab in its directory and
  run it. Add/edit/delete commands in the panel; they are saved to
  `<project>/.pi/commands.json` (committed to the repo, shared with teammates):

  ```json
  {
    "commands": [
      { "name": "dev", "command": "npm run dev", "cwd": "${pwd}" },
      { "name": "test", "command": "npm test", "cwd": "${pwd}/server" },
      { "name": "build", "command": "npm run build", "cwd": "~/other-project" }
    ]
  }
  ```

  `${pwd}` resolves to the agent's current working directory (the one shown in the chat
  view's file panel, changeable via set_cwd); `~` and relative paths also work. The `+`
  button at the top of the command panel creates a new entry.

- **Middle — the terminal**: each tab is a real PTY (your `$SHELL`); output streams live
  and you can type, Ctrl+C, resize, etc. exactly like a desktop terminal.

- **Right — 终端 (tabs)**: VSCode-style vertical tab strip. `+` opens a plain shell in the
  current directory. Closing a tab kills its process.

Notes:

- Running commands keep running while you switch back to the chat view.
- Terminals are killed when the last browser tab for a client disconnects (no orphaned
  dev servers), so a dropped connection resets the terminal view.

## Protocol

See `server/protocol.ts` for the full wire format. Client → server: `hello`,
`prompt`, `abort`, `new_chat`, `cycle_model`, `cycle_thinking`, `get_state`,
`list_sessions`, `switch_session`, `list_files`, `list_models`, `set_model`,
`set_thinking`, `set_cwd`, `complete_path`, `dialog_response`,
`terminal_create`, `terminal_input`, `terminal_resize`, `terminal_kill`,
`run_command`, `list_commands`, `save_commands`.
Server → client: `ready`, `snapshot` (full `UiState`), `tool_delta`, `notice`,
`terminal_output`, `terminal_exit`, `commands`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | server (tsx watch) + Vite dev server with WS proxy |
| `npm run build` | type-check + build frontend and server |
| `npm start` | run the production server (serves `web/dist`) |
| `npm run typecheck` | `tsc --noEmit` for both server and web |
| `node terminal-smoke-test.mjs` | WS-level terminal/commands protocol test (build first) |
| `node terminal-browser-test.mjs` | headless-browser E2E of the terminal view (build first) |

## License

MIT
