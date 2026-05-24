/**
 * Terminal Agent — PTY-backed Claude Code terminal for the gstack browser
 * sidebar. Translates the phoenix gbrowser PTY (cmd/gbd/terminal.go) into
 * Bun, with a few changes informed by codex's outside-voice review:
 *
 *  - Lives in a separate non-compiled bun process from sidebar-agent.ts so
 *    a bug in WS framing or PTY cleanup can't take down the chat path.
 *  - Binds 127.0.0.1 only — never on the dual-listener tunnel surface.
 *  - Origin validation on the WS upgrade is REQUIRED (not defense-in-depth)
 *    because a localhost shell WS is a real cross-site WebSocket-hijacking
 *    target.
 *  - Cookie-based auth via /internal/grant from the parent server, not a
 *    token in /health.
 *  - Lazy spawn: claude PTY is not spawned until the WS receives its first
 *    data frame. Sidebar opens that never type don't burn a claude session.
 *  - PTY dies with WS close (one PTY per WS). v1.1 may add session
 *    survival; for v1 we match phoenix's lifecycle.
 *
 * The PTY uses Bun's `terminal:` spawn option (verified at impl time on
 * Bun 1.3.10): pass cols/rows + a data callback; write input via
 * `proc.terminal.write(buf)`; resize via `proc.terminal.resize(cols, rows)`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { writeSecureFile, mkdirSecure } from './file-permissions';
import { safeUnlink } from './error-handling';
import { writeAgentRecord, clearAgentRecord } from './terminal-agent-control';

const STATE_FILE = process.env.BROWSE_STATE_FILE || path.join(process.env.HOME || '/tmp', '.gstack', 'browse.json');
const PORT_FILE = path.join(path.dirname(STATE_FILE), 'terminal-port');
const BROWSE_SERVER_PORT = parseInt(process.env.BROWSE_SERVER_PORT || '0', 10);
const EXTENSION_ID = process.env.BROWSE_EXTENSION_ID || ''; // optional: tighten Origin check
const INTERNAL_TOKEN = crypto.randomBytes(32).toString('base64url'); // shared with parent server via env at spawn
/**
 * Per-boot generation identifier. Loopback /internal/* callers include
 * `X-Browse-Gen: <CURRENT_GEN>` so a slow agent the watchdog respawned
 * around can't service a stale grant from the prior generation. Absent
 * header means "legacy caller" and is accepted (backward compat); a
 * present-but-mismatched header returns 409 stale generation.
 */
const CURRENT_GEN = crypto.randomBytes(16).toString('base64url');

// In-memory attach-token registry. Parent posts /internal/grant after
// /pty-session; we validate WS upgrades against this map.
//
// v1.44+: each token is bound to a v1.44 sessionId (the stable, non-secret
// identifier from browse/src/pty-session-lease.ts). The token grants ONE
// attach for ONE session — re-attach within the lease window comes through
// /pty-session/reattach, which mints a fresh token for the same sessionId.
//
// Legacy callers can still pass `{token}` without sessionId (the value
// stays null and the WS upgrade still works); those callers don't get
// re-attach because there's no stable identifier to match against.
const validTokens = new Map<string, string | null>(); // token → sessionId

/**
 * Reverse index for re-attach lookups: sessionId → live PtySession.
 * Populated when a WS first attaches with a known sessionId; cleared when
 * the session is disposed or the lease expires. Used by:
 *   - /ws upgrade: if the incoming attachToken maps to a sessionId that
 *     already has a live session, REPLACE its ws ref instead of spawning.
 *   - /internal/restart: enumerate by sessionId, dispose that one session.
 *
 * Kept separate from the WeakMap<ws,PtySession> so re-attach can find the
 * session by id even after the original ws has gone.
 */
const sessionsById = new Map<string, PtySession>();

// Active PTY session per WS. One terminal per connection. Codex finding #4:
// uncaught handlers below catch bugs in framing/cleanup so they don't kill
// the listener loop.
process.on('uncaughtException', (err) => {
  console.error('[terminal-agent] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[terminal-agent] unhandledRejection:', reason);
});

interface PtySession {
  proc: any | null;        // Bun.Subprocess once spawned
  cols: number;
  rows: number;
  cookie: string;
  /**
   * v1.44+ stable session identifier (from pty-session-lease). Null for
   * legacy /internal/grant callers that didn't pass one. Used for
   * targeted /internal/restart and (in Commit 3) re-attach lookups.
   */
  sessionId: string | null;
  spawned: boolean;
  /**
   * 25s server-side WS keepalive interval (v1.44+). Set in the WS `open`
   * handler, cleared in `close`. We send `{type:"ping",ts}` text frames so
   * NAT boxes, proxies, and Chrome's MV3 panel-suspend heuristics see the
   * connection as active; the client either replies with `{type:"pong"}`
   * or fires its own 25s `{type:"keepalive"}` cycle. Either path keeps
   * the underlying TCP from being silently dropped.
   */
  pingInterval: ReturnType<typeof setInterval> | null;
}

/**
 * WS keepalive interval. 25s is comfortably under the lowest common NAT
 * idle timeout (typically 30-60s) and shorter than Chromium's WebSocket
 * dead-peer threshold. Test-overridable via env so the v1.44 e2e tests
 * can compress idle-window assertions to <1s without waiting half a
 * minute per assertion.
 */
const KEEPALIVE_INTERVAL_MS = parseInt(
  process.env.GSTACK_PTY_KEEPALIVE_INTERVAL_MS || '25000',
  10,
);

const sessions = new WeakMap<any, PtySession>(); // ws -> session

/** Find claude on PATH. */
function findClaude(): string | null {
  // Test-only override. Lets the integration tests spawn /bin/bash instead
  // of requiring claude to be installed on every CI runner. NEVER read in
  // production (sidebar UI). Documented in browse/test/terminal-agent-integration.test.ts.
  const override = process.env.BROWSE_TERMINAL_BINARY;
  if (override && fs.existsSync(override)) return override;
  // Bun.which is sync and respects PATH. Falls back to a small list of
  // common install locations if PATH is stripped (e.g., launched from
  // Conductor with a minimal env).
  const which = (Bun as any).which?.('claude');
  if (which) return which;
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.bun/bin/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return null;
}

/** Probe + persist claude availability for the bootstrap card. */
function writeClaudeAvailable(): void {
  const stateDir = path.dirname(STATE_FILE);
  try { mkdirSecure(stateDir); } catch {}
  const found = findClaude();
  const status = {
    available: !!found,
    path: found || undefined,
    install_url: 'https://docs.anthropic.com/en/docs/claude-code',
    checked_at: new Date().toISOString(),
  };
  const target = path.join(stateDir, 'claude-available.json');
  const tmp = path.join(stateDir, `.tmp-claude-${process.pid}`);
  try {
    writeSecureFile(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, target);
  } catch {
    safeUnlink(tmp);
  }
}

/**
 * System-prompt hint passed to claude via --append-system-prompt. Tells
 * claude what tab-awareness affordances exist in this session so it
 * doesn't have to discover them by trial. The user can override anything
 * here just by saying so — system prompt is a soft hint, not a contract.
 *
 * Two paths claude has:
 *   1. Read live state from <stateDir>/tabs.json + active-tab.json
 *      (updated continuously by the gstack browser extension).
 *   2. Run $B tab, $B tabs, $B tab-each <command> to act on tabs. The
 *      tab-each helper fans a single command across every open tab and
 *      returns per-tab results as JSON.
 */
function buildTabAwarenessHint(stateDir: string): string {
  const tabsFile = path.join(stateDir, 'tabs.json');
  const activeFile = path.join(stateDir, 'active-tab.json');
  return [
    'You are running inside the gstack browser sidebar with live access to the user\'s browser tabs.',
    '',
    'Tab state files (kept fresh automatically by the extension):',
    `  ${tabsFile}        — all open tabs (id, url, title, active, pinned)`,
    `  ${activeFile}    — the currently active tab`,
    'Read these any time the user asks about "tabs", "the current page", or anything multi-tab. Do NOT shell out to $B tabs just to learn what\'s open — read the file.',
    '',
    'Tab manipulation commands (via $B):',
    '  $B tab <id>                 — switch to a tab',
    '  $B newtab [url]             — open a new tab',
    '  $B closetab [id]            — close a tab (current if no id)',
    '  $B tab-each <command>       — fan out a command across every tab; returns JSON results',
    '',
    'When the user asks for multi-tab work, prefer $B tab-each. Examples:',
    '  $B tab-each snapshot -i     — grab a snapshot from every tab',
    '  $B tab-each text            — pull clean text from every tab',
    '  $B tab-each title           — list every tab\'s title',
    '',
    'You\'re in a real terminal with a real PTY — slash commands, /resume, ANSI colors all work as in a normal claude session.',
  ].join('\n');
}

/** Spawn claude in a PTY. Returns null if claude not on PATH. */
function spawnClaude(cols: number, rows: number, onData: (chunk: Buffer) => void) {
  const claudePath = findClaude();
  if (!claudePath) return null;

  // Match phoenix env so claude knows which browse server to talk to and
  // doesn't try to autostart its own. BROWSE_HEADED=1 keeps the existing
  // headed-mode browser; BROWSE_NO_AUTOSTART prevents claude's gstack
  // tooling from racing to spawn another server.
  const env: Record<string, string> = {
    ...process.env as any,
    BROWSE_PORT: String(BROWSE_SERVER_PORT),
    BROWSE_STATE_FILE: STATE_FILE,
    BROWSE_NO_AUTOSTART: '1',
    BROWSE_HEADED: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };

  // --append-system-prompt is the right injection surface (per `claude --help`):
  // it gets appended to the model's system prompt, so claude treats this as
  // contextual guidance, not a user message. Don't use a leading PTY write
  // for this — that would show up as if the user typed the hint, polluting
  // the visible transcript.
  const stateDir = path.dirname(STATE_FILE);
  const tabHint = buildTabAwarenessHint(stateDir);

  const proc = (Bun as any).spawn([claudePath, '--append-system-prompt', tabHint], {
    terminal: {
      rows,
      cols,
      data(_terminal: any, chunk: Buffer) { onData(chunk); },
    },
    env,
  });
  return proc;
}

/** Cleanup a PTY session: SIGINT, then SIGKILL after 3s. */
function disposeSession(session: PtySession): void {
  try { session.proc?.terminal?.close?.(); } catch {}
  if (session.proc?.pid) {
    try { session.proc.kill?.('SIGINT'); } catch {}
    setTimeout(() => {
      try {
        if (session.proc && !session.proc.killed) session.proc.kill?.('SIGKILL');
      } catch {}
    }, 3000);
  }
  session.proc = null;
  session.spawned = false;
}

/**
 * Build the HTTP server. Two routes:
 *   POST /internal/grant — parent server pushes a fresh cookie token
 *   GET  /ws             — extension upgrades to WebSocket (PTY transport)
 *
 * Everything else returns 404. The listener binds 127.0.0.1 only.
 */
/**
 * Validate a loopback /internal/* request. Returns null when the request
 * is allowed; otherwise returns the Response to send back. Centralizes
 * bearer auth + the v1.44 X-Browse-Gen generation check so adding a new
 * /internal/* route is a one-liner.
 */
function checkInternalAuth(req: Request): Response | null {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
    return new Response('forbidden', { status: 403 });
  }
  const headerGen = req.headers.get('x-browse-gen');
  if (headerGen && headerGen !== CURRENT_GEN) {
    return new Response('stale generation', { status: 409 });
  }
  return null;
}

/**
 * Wrap a JSON-bodied /internal/* handler with the standard bearer-auth +
 * generation-check + json-parse + error-response boilerplate. The handler
 * `fn` is called with the parsed body; whatever it returns is JSON-stringified
 * into a 200 Response, or the handler can return a Response directly to
 * customize status / headers. Throwing from `fn` collapses to a 400 "bad".
 *
 * Centralizing the dance kills the copy-paste pattern of bearer + gen check
 * + req.json().then(...).catch(...) that every /internal/* route needs.
 * New routes become a single call to internalHandler.
 */
async function internalHandler<T>(
  req: Request,
  fn: (body: any) => T | Promise<T> | Response | Promise<Response>,
): Promise<Response> {
  const denied = checkInternalAuth(req);
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('bad', { status: 400 });
  }
  try {
    const result = await fn(body);
    if (result instanceof Response) return result;
    if (result === undefined || result === null) return new Response('ok');
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response('bad', { status: 400 });
  }
}

/**
 * Spawn the claude PTY for a session if it hasn't been spawned yet.
 * Used by both the legacy binary-frame spawn trigger and the v1.44 explicit
 * `{type:"start"}` text-frame trigger. Idempotent on `session.spawned`.
 *
 * Returns true if claude is now running, false if spawn failed (e.g. claude
 * binary not on PATH). On failure, the caller is expected to have already
 * surfaced the error to the client (or will via the next frame).
 */
function maybeSpawnPty(ws: any, session: PtySession): boolean {
  if (session.spawned) return true;
  session.spawned = true;
  let leftover = Buffer.alloc(0);
  const proc = spawnClaude(session.cols, session.rows, (chunk) => {
    const combined = Buffer.concat([leftover, Buffer.from(chunk)]);
    // UTF-8 boundary detection (issue #1272). Look back at most 3 bytes
    // for the start of an incomplete multibyte sequence and defer it.
    let safeEnd = combined.length;
    for (let i = combined.length - 1; i >= Math.max(0, combined.length - 3); i--) {
      const b = combined[i];
      if ((b & 0x80) === 0) { safeEnd = i + 1; break; }
      if ((b & 0xC0) === 0x80) continue;
      const expected = (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : 4;
      safeEnd = (combined.length - i >= expected) ? combined.length : i;
      break;
    }
    const flush = combined.slice(0, safeEnd);
    leftover = combined.slice(safeEnd);
    if (flush.length) {
      try { ws.sendBinary(flush); } catch {}
    }
  });
  if (!proc) {
    try {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'CLAUDE_NOT_FOUND',
        message: 'claude CLI not on PATH. Install: https://docs.anthropic.com/en/docs/claude-code',
      }));
      ws.close(4404, 'claude not found');
    } catch {}
    return false;
  }
  session.proc = proc;
  proc.exited?.then?.(() => {
    try { ws.close(1000, 'pty exited'); } catch {}
  });
  return true;
}

function buildServer() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0, // PTY connections are long-lived; default idleTimeout would kill them

    fetch(req, server) {
      const url = new URL(req.url);

      // /internal/grant — loopback-only handshake from parent server.
      // v1.44+: accepts `{token, sessionId?}`. The sessionId binding lets
      // the agent route re-attach attempts (same sessionId, fresh token)
      // back to the same PtySession. Legacy callers passing just `{token}`
      // still work — sessionId becomes null and re-attach is unavailable
      // for that grant.
      if (url.pathname === '/internal/grant' && req.method === 'POST') {
        return internalHandler(req, (body) => {
          if (typeof body?.token === 'string' && body.token.length > 16) {
            const sid = typeof body?.sessionId === 'string' && body.sessionId.length > 0
              ? body.sessionId
              : null;
            validTokens.set(body.token, sid);
          }
        });
      }

      // /internal/revoke — drop a token (called on WS close or bootstrap reload)
      if (url.pathname === '/internal/revoke' && req.method === 'POST') {
        return internalHandler(req, (body) => {
          if (typeof body?.token === 'string') validTokens.delete(body.token);
        });
      }

      // /internal/restart — dispose the PtySession for a specific sessionId.
      // Scoped to one caller (not enumerate-all). Server.ts /pty-restart
      // posts here with the caller's sessionId; we kill ONLY that PTY,
      // leaving any other live sidebar tabs untouched. Codex T2 of the
      // eng review caught this gap — pre-spec the route would have
      // disposed all sessions.
      if (url.pathname === '/internal/restart' && req.method === 'POST') {
        return internalHandler(req, (body) => {
          const sid = typeof body?.sessionId === 'string' ? body.sessionId : null;
          if (!sid) return { killed: 0 };
          const session = sessionsById.get(sid);
          if (!session) return { killed: 0 };
          disposeSession(session);
          sessionsById.delete(sid);
          return { killed: 1 };
        });
      }

      // /internal/healthz — liveness probe used by the v1.44 watchdog.
      // Returns this agent's pid + gen + active session count without
      // touching claude binary lookup (which can fail for non-process
      // reasons and isn't a useful liveness signal). GET — no body to parse,
      // so it stays on the bare checkInternalAuth gate.
      if (url.pathname === '/internal/healthz' && req.method === 'GET') {
        const denied = checkInternalAuth(req);
        if (denied) return denied;
        return new Response(JSON.stringify({
          pid: process.pid,
          gen: CURRENT_GEN,
          sessions: validTokens.size,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // /claude-available — bootstrap card hits this when user clicks "I installed it".
      if (url.pathname === '/claude-available' && req.method === 'GET') {
        writeClaudeAvailable();
        const found = findClaude();
        return new Response(JSON.stringify({ available: !!found, path: found }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // /ws — WebSocket upgrade. CRITICAL gates:
      //   (1) Origin must be chrome-extension://<id>. Cross-site WS hijacking
      //       defense — required, not optional.
      //   (2) Token must be in validTokens. We accept the token via two
      //       transports for compatibility:
      //         - Sec-WebSocket-Protocol (preferred for browsers — the only
      //           auth header settable from the browser WebSocket API)
      //         - Cookie gstack_pty (works for non-browser callers and
      //           same-port browser callers; doesn't survive the cross-port
      //           jump from server.ts:34567 to the agent's random port
      //           when SameSite=Strict is set)
      //       Either path works; both verify against the same in-memory
      //       validTokens Set, populated by the parent server's
      //       authenticated /pty-session → /internal/grant chain.
      if (url.pathname === '/ws') {
        const origin = req.headers.get('origin') || '';
        const isExtensionOrigin = origin.startsWith('chrome-extension://');
        if (!isExtensionOrigin) {
          return new Response('forbidden origin', { status: 403 });
        }
        if (EXTENSION_ID && origin !== `chrome-extension://${EXTENSION_ID}`) {
          return new Response('forbidden origin', { status: 403 });
        }

        // Try Sec-WebSocket-Protocol first. Format: a single token, possibly
        // with a `gstack-pty.` prefix (which we strip). Browsers send a
        // comma-separated list when multiple were requested; we pick the
        // first that matches a known token.
        const protoHeader = req.headers.get('sec-websocket-protocol') || '';
        let token: string | null = null;
        let acceptedProtocol: string | null = null;
        for (const raw of protoHeader.split(',').map(s => s.trim()).filter(Boolean)) {
          const candidate = raw.startsWith('gstack-pty.') ? raw.slice('gstack-pty.'.length) : raw;
          if (validTokens.has(candidate)) {
            token = candidate;
            acceptedProtocol = raw;
            break;
          }
        }

        // Fallback: Cookie gstack_pty (legacy / non-browser callers).
        if (!token) {
          const cookieHeader = req.headers.get('cookie') || '';
          for (const part of cookieHeader.split(';')) {
            const [name, ...rest] = part.trim().split('=');
            if (name === 'gstack_pty') {
              const candidate = rest.join('=') || null;
              if (candidate && validTokens.has(candidate)) {
                token = candidate;
              }
              break;
            }
          }
        }

        if (!token) {
          return new Response('unauthorized', { status: 401 });
        }

        // v1.44+: surface the token's sessionId binding to the upgraded ws.
        // open() reads it via ws.data and registers the session in
        // sessionsById so /internal/restart and (Commit 3) re-attach
        // lookups can find it.
        const sessionId = validTokens.get(token) ?? null;
        const upgraded = server.upgrade(req, {
          data: { cookie: token, sessionId },
          // Echo the protocol back so the browser accepts the upgrade.
          // Required when the client sends Sec-WebSocket-Protocol — the
          // server MUST select one of the offered protocols, otherwise
          // the browser closes the connection immediately.
          ...(acceptedProtocol ? { headers: { 'Sec-WebSocket-Protocol': acceptedProtocol } } : {}),
        });
        return upgraded ? undefined : new Response('upgrade failed', { status: 500 });
      }

      return new Response('not found', { status: 404 });
    },

    websocket: {
      /**
       * Spawn the claude PTY for `session` if it hasn't been spawned yet.
       * Called from both message paths: the legacy binary-frame trigger
       * (any keystroke) AND the v1.44 explicit `{type:"start"}` trigger
       * (forceRestart sends this on every fresh WS to get an eager prompt
       * without requiring the user to type). Idempotent — a second call
       * after `spawned: true` is a no-op.
       */
      open(ws) {
        const sessionId = (ws.data as any)?.sessionId ?? null;
        const session: PtySession = {
          proc: null,
          cols: 80,
          rows: 24,
          cookie: (ws.data as any)?.cookie || '',
          sessionId,
          spawned: false,
          pingInterval: null,
        };
        session.pingInterval = setInterval(() => {
          try {
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
          } catch {
            // ws likely closed mid-tick; close handler clears the interval.
          }
        }, KEEPALIVE_INTERVAL_MS);
        sessions.set(ws, session);
        // Index by sessionId for /internal/restart + (Commit 3) re-attach.
        if (sessionId) sessionsById.set(sessionId, session);
      },

      message(ws, raw) {
        let session = sessions.get(ws);
        if (!session) {
          // Fallback for any path where open() didn't fire (shouldn't happen
          // in Bun.serve but keeps the spawn path safe). No keepalive on
          // this branch — open() is the supported entry point.
          session = {
            proc: null,
            cols: 80,
            rows: 24,
            cookie: (ws.data as any)?.cookie || '',
            sessionId: (ws.data as any)?.sessionId ?? null,
            spawned: false,
            pingInterval: null,
          };
          sessions.set(ws, session);
          if (session.sessionId) sessionsById.set(session.sessionId, session);
        }

        // Text frames are control messages: {type: "resize", cols, rows},
        // {type: "tabSwitch", tabId, url, title}, {type: "tabState", ...},
        // or v1.44 keepalive frames: {type: "pong", ts}, {type: "keepalive"}.
        // Binary frames are raw input bytes destined for the PTY stdin.
        if (typeof raw === 'string') {
          let msg: any;
          try { msg = JSON.parse(raw); } catch { return; }
          if (msg?.type === 'resize') {
            const cols = Math.max(2, Math.floor(Number(msg.cols) || 80));
            const rows = Math.max(2, Math.floor(Number(msg.rows) || 24));
            session.cols = cols;
            session.rows = rows;
            try { session.proc?.terminal?.resize?.(cols, rows); } catch {}
            return;
          }
          if (msg?.type === 'tabSwitch') {
            handleTabSwitch(msg);
            return;
          }
          if (msg?.type === 'tabState') {
            handleTabState(msg);
            return;
          }
          if (msg?.type === 'pong' || msg?.type === 'keepalive' || msg?.type === 'ping') {
            // Keepalive frames — accepted and silently dropped. The mere
            // fact that the WS carried this frame is the liveness signal;
            // there's no application-level state to update at this layer.
            // `ping` is acknowledged here too in case the client (or a
            // future agent peer) mirrors our server-side ping shape.
            return;
          }
          if (msg?.type === 'start') {
            // v1.44 explicit spawn trigger. forceRestart sends this
            // immediately on every fresh WS so claude boots without the
            // user having to type a keystroke (pre-v1.44, the lazy-binary
            // spawn made restart look stuck until the user typed). No-op
            // if already spawned.
            maybeSpawnPty(ws, session);
            return;
          }
          // Unknown text frame — ignore.
          return;
        }

        // Binary input. Lazy-spawn claude on the first byte if `start`
        // wasn't sent first. Both paths land in the same maybeSpawnPty
        // helper for behavior parity.
        if (!session.spawned) {
          if (!maybeSpawnPty(ws, session)) return;
        }
        try {
          // raw is a Uint8Array; Bun.Terminal.write accepts string|Buffer.
          // Convert to Buffer for safety.
          session.proc?.terminal?.write?.(Buffer.from(raw as Uint8Array));
        } catch (err) {
          console.error('[terminal-agent] terminal.write failed:', err);
        }
      },

      close(ws) {
        const session = sessions.get(ws);
        if (session) {
          if (session.pingInterval) {
            clearInterval(session.pingInterval);
            session.pingInterval = null;
          }
          disposeSession(session);
          if (session.cookie) {
            // Drop the cookie so it can't be replayed against a new PTY.
            validTokens.delete(session.cookie);
          }
          // Drop the sessionId index too (Commit 3 will revisit this for
          // re-attach where we WANT the session to outlive the original ws
          // for the 60s detach window; for now, close = full dispose).
          if (session.sessionId) sessionsById.delete(session.sessionId);
          sessions.delete(ws);
        }
      },
    },
  });
}

/**
 * Tab-switch helper: write the active tab to a state file (claude reads it)
 * and notify the parent server so its activeTabId stays synced. Skips
 * chrome:// and chrome-extension:// internal pages.
 */
/**
 * Live tab snapshot. Writes <stateDir>/tabs.json (full list) and updates
 * <stateDir>/active-tab.json (current active). claude can read these any
 * time without invoking $B tabs — saves a round-trip when the model just
 * needs to check the landscape before deciding what to do.
 */
function handleTabState(msg: {
  active?: { tabId?: number; url?: string; title?: string } | null;
  tabs?: Array<{ tabId?: number; url?: string; title?: string; active?: boolean; windowId?: number; pinned?: boolean; audible?: boolean }>;
  reason?: string;
}): void {
  const stateDir = path.dirname(STATE_FILE);
  try { mkdirSecure(stateDir); } catch {}

  // tabs.json — full list
  if (Array.isArray(msg.tabs)) {
    const payload = {
      updatedAt: new Date().toISOString(),
      reason: msg.reason || 'unknown',
      tabs: msg.tabs.map(t => ({
        tabId: t.tabId ?? null,
        url: t.url || '',
        title: t.title || '',
        active: !!t.active,
        windowId: t.windowId ?? null,
        pinned: !!t.pinned,
        audible: !!t.audible,
      })),
    };
    const target = path.join(stateDir, 'tabs.json');
    const tmp = path.join(stateDir, `.tmp-tabs-${process.pid}`);
    try {
      writeSecureFile(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, target);
    } catch {
      safeUnlink(tmp);
    }
  }

  // active-tab.json — single active tab. Skip chrome-internal pages so
  // claude doesn't see chrome:// or chrome-extension:// URLs as
  // "current target."
  const active = msg.active;
  if (active && active.url && !active.url.startsWith('chrome://') && !active.url.startsWith('chrome-extension://')) {
    const ctxFile = path.join(stateDir, 'active-tab.json');
    const tmp = path.join(stateDir, `.tmp-tab-${process.pid}`);
    try {
      writeSecureFile(tmp, JSON.stringify({
        tabId: active.tabId ?? null,
        url: active.url,
        title: active.title ?? '',
      }));
      fs.renameSync(tmp, ctxFile);
    } catch {
      safeUnlink(tmp);
    }
  }
}

function handleTabSwitch(msg: { tabId?: number; url?: string; title?: string }): void {
  const url = msg.url || '';
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  const stateDir = path.dirname(STATE_FILE);
  const ctxFile = path.join(stateDir, 'active-tab.json');
  const tmp = path.join(stateDir, `.tmp-tab-${process.pid}`);
  try {
    writeSecureFile(tmp, JSON.stringify({
      tabId: msg.tabId ?? null,
      url,
      title: msg.title ?? '',
    }));
    fs.renameSync(tmp, ctxFile);
  } catch {
    safeUnlink(tmp);
  }

  // Best-effort sync to parent server so its activeTabId tracking matches.
  // No await; this is fire-and-forget.
  if (BROWSE_SERVER_PORT > 0) {
    fetch(`http://127.0.0.1:${BROWSE_SERVER_PORT}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${readBrowseToken()}`,
      },
      body: JSON.stringify({
        command: 'tab',
        args: [String(msg.tabId ?? ''), '--no-focus'],
      }),
    }).catch(() => {});
  }
}

function readBrowseToken(): string {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const j = JSON.parse(raw);
    return j.token || '';
  } catch { return ''; }
}

// Boot.
function main() {
  writeClaudeAvailable();
  const server = buildServer();
  const port = (server as any).port || (server as any).address?.port;
  if (!port) {
    console.error('[terminal-agent] failed to bind: no port');
    process.exit(1);
  }

  // Write port file atomically so the parent server can pick it up.
  const dir = path.dirname(PORT_FILE);
  try { mkdirSecure(dir); } catch {}
  const tmp = `${PORT_FILE}.tmp-${process.pid}`;
  writeSecureFile(tmp, String(port));
  fs.renameSync(tmp, PORT_FILE);

  // Write identity-based agent record (pid + per-boot gen). Replaces the
  // v1.43- `pkill -f terminal-agent\.ts` regex teardown that could kill
  // sibling gstack sessions. Callers (cli.ts spawn site, server.ts
  // shutdown, the v1.44 watchdog) now route through killAgentByRecord in
  // terminal-agent-control.ts.
  writeAgentRecord(dir, { pid: process.pid, gen: CURRENT_GEN, startedAt: Date.now() });

  // Hand the parent the internal token so it can call /internal/grant.
  // Parent learns INTERNAL_TOKEN via env (TERMINAL_AGENT_INTERNAL_TOKEN below).
  // We just print it on stdout for the supervising process to pick up if it's
  // not already in env. Defense against env races at spawn time.
  console.log(`[terminal-agent] listening on 127.0.0.1:${port} pid=${process.pid} gen=${CURRENT_GEN}`);

  // Cleanup port file + agent record on exit.
  const cleanup = () => {
    safeUnlink(PORT_FILE);
    clearAgentRecord(dir);
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

// Export the internal token so cli.ts can pass the SAME value to the parent
// server via env. Parent reads BROWSE_TERMINAL_INTERNAL_TOKEN and uses it
// for /internal/grant calls.
//
// In practice, the agent generates INTERNAL_TOKEN once at boot and writes it
// to a state file the parent reads. This avoids env-passing races. See main().
const INTERNAL_TOKEN_FILE = path.join(path.dirname(STATE_FILE), 'terminal-internal-token');
try {
  mkdirSecure(path.dirname(INTERNAL_TOKEN_FILE));
  writeSecureFile(INTERNAL_TOKEN_FILE, INTERNAL_TOKEN);
} catch {}

main();
