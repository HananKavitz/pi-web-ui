#!/usr/bin/env node
/**
 * pi-web-ui CLI entry.
 *
 * Starts the production server (serves the built frontend + WebSocket API).
 * Env vars: PORT (default 8787), PI_WEB_CWD, PI_WEB_DATA_DIR, PI_CODING_AGENT_DIR.
 * See README.md for details.
 */
import "../dist/server/index.js";
