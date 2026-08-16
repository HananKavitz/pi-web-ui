# pi-web-ui

**English** | [简体中文](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.zh-CN.md)

A web chat interface for the [pi coding agent](https://pi.dev) — the agent runs
in-process via the pi SDK and streams events to the browser over WebSocket. Chat
with thinking blocks and tool calls, attach files, ask about images, use a
built-in terminal, manage models, tweak the system prompt, toggle skills and
extensions on/off, and save/apply settings presets — all from a settings panel.
Requires Node.js ≥ 22.19 and a configured pi install.

## Screenshots

![pi-web-ui main interface](https://cdn.jsdelivr.net/gh/xing-shuyin/pi-web-ui@main/assets/shot.jpeg)

## Install

```bash
npm i -g pi-web-ui            # global install (recommended)
npx pi-web-ui                 # or run without installing (latest, starts on :8787)
npm i -g .                    # or install the local checkout
```

**npm ≥ 12?** npm 12+ blocks dependency install scripts by default (you'll see
`npm warn install-scripts … blocked`). node-pty is a native module, so allow its
script (the other two packages it lists are harmless no-ops — allowing them just
silences the warning):

```bash
npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
```

## Start

```bash
pi-web-ui                                           # foreground, http://localhost:8787
PORT=9000 PI_WEB_CWD=/path/to/project pi-web-ui     # custom port / workspace
```

## Stop

- **Foreground**: press `Ctrl+C` in the terminal running it.
- **As a service**: `pi-web-ui server stop` (stops the instance; auto-start stays until `server uninstall`).

## Update

```bash
npm i -g pi-web-ui@latest     # upgrade to the latest published version
pi-web-ui server restart      # restart the service to apply it (foreground: restart manually)
```

## Uninstall

```bash
npm uninstall -g pi-web-ui
```

Uninstalling does **not** delete your chats — session data lives in
`<cwd>/.pi-web` (or `PI_WEB_DATA_DIR`) and survives uninstall/upgrade.

## Run as a system service (auto-start on boot)

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project   # install + start
pi-web-ui server status                     # running? auto-start?
pi-web-ui server restart                    # restart (applies config/version changes)
pi-web-ui server stop                       # stop (auto-start stays)
pi-web-ui server start                      # start again
pi-web-ui server uninstall                  # remove the service entirely
pi-web-ui server shortcut                   # desktop one-click launch icon
pi-web-ui server quiesce                    # drain: refuse NEW chats/messages, let running ones finish
pi-web-ui server unquiesce                  # reopen admission
```

`server status` also shows live stats via a local control socket (version,
PID, quiesce state, connected browsers, running conversations) — the same
socket drives `quiesce`/`unquiesce`.

## Security

- **Loopback-only by default** — the server binds `127.0.0.1` and is not
  reachable from the network unless you explicitly set `PI_WEB_HOST=0.0.0.0`
  (e.g. LAN access, Docker port mapping — the compose file sets it for you).
- **WebSocket origin check** — browser pages connecting to `/ws` must present
  an `Origin` whose hostname **and port** match the request `Host`;
  cross-origin pages are rejected with 403. Non-browser clients (no `Origin`)
  are unaffected. Add `PI_WEB_ALLOW_ORIGINS=http://your-host:port` for
  reverse-proxy setups.
- **Quiesce** — `server quiesce` refuses new prompts/forks/session resumes
  until you `server unquiesce`; in-flight runs finish cleanly (useful before
  upgrades/backups).
- **Credentials stay server-side** — provider `headers` (which may carry
  `Authorization` / API keys) are never sent to the browser; the model
  management UI edits everything else and the server preserves the headers.

- **macOS** → launchd agent (no sudo), logs to `/tmp/pi-web-ui.log` / `.err`
- **Linux** → systemd unit (`systemctl enable --now`), logs via `journalctl -u pi-web-ui -f`
- **Windows** → Task Scheduler logon task (hidden PowerShell window, no black console)

Options: `--port` (default 8787), `--cwd` (workspace), `--data-dir` (sessions),
`--name` (custom service name). Rerunning `server install` with new options
regenerates the config and restarts the service — that's how you change its
port/cwd.

## License

MIT
