// host.mjs — Concourse local host (Node 20+, ESM).
//
// This is the irreducible piece: the browser cannot spawn a process, so a thin
// Node host wraps one Claude Code agent loop, normalises its event stream into
// turn-level state, and serves a single-file front end over loopback.
//
// Build order (see CLAUDE.md): this file grows one unit at a time.
//   Unit 1 (this)   — express + ws skeleton, health check. Prove the socket.
//   Unit 2 (next)   — CliEngine: spawn `claude -p`, consume NDJSON, emit RawEvent.
//   Unit 3          — EventNormaliser (§5).
//   Unit 4          — StateReducer (§6).
//
// The pure pieces (normaliser, reducer, engine) are exported so `node --test`
// can drive them without starting the server. Server bootstrap is guarded
// behind a main-module check at the bottom of the file.

import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Loopback bind IS the auth model for v0.1 (spec §14). Do not bind 0.0.0.0.
export const HOST = '127.0.0.1';
export const PORT = 7317;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace root the agent runs against.
 * Precedence: CONCOURSE_WORKSPACE env → first CLI arg → <repo>/workspace.
 * A leading `~` is expanded to the user's home directory.
 * @param {{ env?: NodeJS.ProcessEnv, argv?: string[] }} [opts]
 * @returns {string} absolute path
 */
export function resolveWorkspaceRoot({ env = process.env, argv = process.argv } = {}) {
  const raw = env.CONCOURSE_WORKSPACE || argv[2] || path.join(__dirname, 'workspace');
  const expanded = raw.startsWith('~')
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  return path.resolve(expanded);
}

/**
 * Ensure the workspace directory exists. Created lazily so a fresh checkout
 * boots without a manual mkdir.
 * @param {string} workspaceRoot
 */
export function ensureWorkspace(workspaceRoot) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

// ---------------------------------------------------------------------------
// Host state (in-memory, single session for v0.1)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} HostState
 * @property {string} workspaceRoot
 * @property {string|null} sessionId  captured from SESSION_OPEN once a turn runs
 * @property {import('./host.mjs').CliEngine|null} activeEngine  the in-flight turn's engine, if any
 * @property {Set<import('ws').WebSocket>} clients  connected browsers
 * @property {ReturnType<typeof createInitialState>} turnState  the held reducer state
 * @property {string|null} lastSentState  serialised last-broadcast projection (dedupe)
 */

/** @returns {HostState} */
export function createHostState(workspaceRoot) {
  return {
    workspaceRoot,
    sessionId: null,
    activeEngine: null,
    clients: new Set(),
    turnState: createInitialState(workspaceRoot),
    lastSentState: null,
  };
}

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------

/**
 * Build the express app. Kept as a factory so tests can mount it without a
 * listening socket.
 * @param {HostState} hostState
 */
export function createApp(hostState) {
  const app = express();
  const appHtmlPath = path.join(__dirname, 'app.html');

  // GET / — the single-file front end. Not built until unit 5; until then a
  // plain placeholder so a browser hit doesn't 404 during backend work.
  app.get('/', (_req, res) => {
    if (fs.existsSync(appHtmlPath)) {
      res.sendFile(appHtmlPath);
    } else {
      res
        .status(200)
        .type('text/plain')
        .send('Concourse host is running. The interface has not been built yet.');
    }
  });

  // GET /health — liveness + current session snapshot. Used to prove the host
  // is up and to confirm session capture in later units.
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      workspaceRoot: hostState.workspaceRoot,
      sessionId: hostState.sessionId,
    });
  });

  // Fonts packaged with the app and served same-origin, so app.html pulls its
  // typefaces locally and makes no external font request (unit 5).
  app.use('/fonts', express.static(path.join(__dirname, 'fonts'), {
    immutable: true,
    maxAge: '1y',
  }));

  // Scoped file surface (§11). All three endpoints route their `path` query
  // through WorkspaceFs, which rejects any escape with 403.
  const wsfs = new WorkspaceFs(hostState.workspaceRoot);
  const FILE_TEXT_CAP = 1024 * 1024; // 1 MB (§11)

  const sendFsError = (res, e) => {
    if (e instanceof WorkspaceError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'Something went wrong reading your files.' });
  };

  app.get('/api/files', (req, res) => {
    try {
      res.json({ entries: wsfs.list(req.query.path) });
    } catch (e) {
      sendFsError(res, e);
    }
  });

  app.get('/api/file', (req, res) => {
    try {
      const { text, truncated, size } = wsfs.readTextCapped(req.query.path, FILE_TEXT_CAP);
      res
        .set('X-Truncated', truncated ? '1' : '0')
        .set('X-Size', String(size))
        .type('text/plain; charset=utf-8')
        .send(text);
    } catch (e) {
      sendFsError(res, e);
    }
  });

  app.get('/api/download', (req, res) => {
    try {
      const abs = wsfs.fileForDownload(req.query.path);
      res.download(abs, path.basename(abs)); // Content-Disposition: attachment
    } catch (e) {
      sendFsError(res, e);
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// WebSocket wiring
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocketServer to an existing HTTP server, upgrading only on the
 * `/session` path. On connect the client receives the current state so the UI
 * can render something legible before the first turn.
 *
 * Unit 1 handles connect + a state hello only. Inbound {submit,approve,interrupt}
 * messages arrive in unit 2 when the engine is wired in.
 *
 * @param {http.Server} server
 * @param {HostState} hostState
 * @returns {WebSocketServer}
 */
export function attachSessionSocket(server, hostState) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
    if (pathname !== '/session') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    hostState.clients.add(ws);
    // Replay the current state so a refresh (or a second tab) lands exactly
    // where the turn actually is, not back at idle (§7 reconnect, in miniature).
    send(ws, { type: 'state', state: projectState(hostState.turnState) });
    send(ws, { type: 'session', sessionId: hostState.sessionId });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON frames
      }
      handleClientMessage(ws, hostState, msg);
    });
    ws.on('close', () => hostState.clients.delete(ws));
  });

  return wss;
}

/**
 * Broadcast a message to every connected browser. State is host-authoritative
 * and shared across tabs.
 * @param {HostState} hostState
 * @param {object} message
 */
export function broadcast(hostState, message) {
  for (const ws of hostState.clients) send(ws, message);
}

/**
 * Project the reducer state down to the fields the UI renders. Absolute paths
 * never appear in a headline — `truePath` is carried only as a tooltip source,
 * and host bookkeeping (workspaceRoot, currentToolUseId) is dropped. `narration`
 * is deliberately excluded so the StatusRail doesn't re-broadcast on every token
 * delta; streamed prose belongs to the transcript (unit 6).
 * @param {ReturnType<typeof createInitialState>} s
 */
export function projectState(s) {
  return {
    state: s.state,
    activity: s.activity,
    friendlyName: s.friendlyName,
    truePath: s.truePath,
    filesTouched: s.filesTouched,
    reason: s.reason,
    // Raw failure text can carry absolute paths (a result message, a host error);
    // redact the workspace root so it stays workspace-relative in the UI.
    detail: redactWorkspacePaths(s.detail, s.workspaceRoot),
    note: redactWorkspacePaths(s.note, s.workspaceRoot),
    turn: s.turn,
    startedAt: s.startedAt,
    sessionId: s.sessionId,
    model: s.model,
  };
}

/** Flatten a tool_result content (string, or array of blocks) to plain text. */
function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return String(content);
}

/** Cap a string so one large file read can't bloat a single transcript frame. */
function capText(s, max) {
  if (typeof s !== 'string' || s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} more characters)`;
}

/**
 * Strip the absolute workspace root out of any raw text bound for the browser,
 * so tool output and error detail stay workspace-relative. Absolute paths never
 * reach the UI (CLAUDE.md design constraint) — the true path lives only in a
 * tooltip the reducer carries separately. Handles both slash conventions.
 * @param {string} text
 * @param {string|null} workspaceRoot
 */
export function redactWorkspacePaths(text, workspaceRoot) {
  if (typeof text !== 'string' || !workspaceRoot) return text;
  const roots = [workspaceRoot, workspaceRoot.replace(/\\/g, '/'), workspaceRoot.replace(/\//g, '\\')];
  let out = text;
  for (const r of roots) {
    if (!r) continue;
    out = out.split(`${r}\\`).join('').split(`${r}/`).join('').split(r).join('the workspace');
  }
  return out;
}

/**
 * Enrich a normalised event for the transcript stream. TOOL_START gets the same
 * friendly name (§6.3) the rail uses so the two agree; TOOL_END's raw result is
 * flattened to text and capped. Everything else passes through untouched.
 * @param {{ kind: string, [k: string]: any }} evt
 * @param {string} workspaceRoot
 */
export function enrichEvent(evt, workspaceRoot) {
  if (evt.kind === N.TOOL_START) {
    const abs = evt.input && (evt.input.file_path || evt.input.notebook_path || evt.input.path);
    if (abs) {
      const fn = friendlyName(abs, workspaceRoot);
      return { ...evt, friendly: fn.friendly, truePath: fn.truePath };
    }
    return evt;
  }
  if (evt.kind === N.TOOL_END) {
    const text = redactWorkspacePaths(toText(evt.content), workspaceRoot);
    return { ...evt, content: capText(text, 4000) };
  }
  return evt;
}

/**
 * Send a JSON message over a socket if it is open. Centralised so every host→
 * browser message is serialised the same way.
 * @param {import('ws').WebSocket} ws
 * @param {object} message
 */
export function send(ws, message) {
  // Compare against the static constant on the imported class rather than an
  // instance property, so the check is unambiguous regardless of how the socket
  // was constructed.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Route an inbound browser→host message (§11). Three verbs in v0.1: submit,
 * interrupt, approve.
 * @param {import('ws').WebSocket} ws
 * @param {HostState} hostState
 * @param {{ type?: string, prompt?: string, requestId?: string, decision?: string }} msg
 */
export function handleClientMessage(ws, hostState, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'submit':
      if (typeof msg.prompt !== 'string' || msg.prompt.trim() === '') return;
      if (hostState.activeEngine) {
        // One turn at a time in v0.1. Silently drop overlapping submits.
        return;
      }
      // Fire and forget; runTurn streams state to every connected browser.
      runTurn(hostState, msg.prompt);
      break;
    case 'interrupt':
      if (hostState.activeEngine) hostState.activeEngine.interrupt();
      break;
    case 'approve':
      // CliEngine: no-op (allowlist decided in advance). Real path is v0.2.
      if (hostState.activeEngine) {
        hostState.activeEngine.respondToPermission(msg.requestId, msg.decision);
      }
      break;
    default:
      // Unknown verb — ignore rather than crash the socket.
      break;
  }
}

// ---------------------------------------------------------------------------
// Agent engine (§4)
// ---------------------------------------------------------------------------

/**
 * The loose coupler. Two engines will implement this: CliEngine (v0.1, spawns
 * the CLI) and SdkEngine (v0.2, the Agent SDK with a real permission callback).
 * Building to the interface keeps that swap a one-line change (§4, soul.md).
 *
 * @typedef {Object} IAgentEngine
 * @property {(opts: { prompt: string, sessionId?: string|null, cwd: string }) => AsyncIterable<RawEvent>} start
 * @property {(requestId: string, decision: 'allow'|'deny') => void} respondToPermission
 * @property {() => Promise<void>} interrupt
 * @property {{ permissionCallbacks: boolean, nativeMultiTurn: boolean }} capabilities
 */

/**
 * A raw event off the engine. For CliEngine these are the parsed stream-json
 * objects from the CLI (they carry their own `type`), plus a few host-internal
 * synthetic events (double-underscore prefix) for out-of-band conditions the
 * stream itself cannot express — stderr, non-zero exit, spawn failure, an
 * unparseable line. The normaliser (unit 3) maps all of these to §5 events.
 * @typedef {object} RawEvent
 */

/**
 * CliEngine — day-one proof (§4.1). Spawns `claude -p` per turn and streams its
 * newline-delimited JSON. One process per turn; multi-turn via captured
 * session_id + `--resume`. Permission handling is flag-only here (no callback),
 * so the allowlist is conservative and Bash is never granted (§4.1, Rule 5).
 *
 * @implements {IAgentEngine}
 */
export class CliEngine {
  /** @param {{ bin?: string }} [opts] */
  constructor({ bin } = {}) {
    // `claude` is a native .exe here, so shell:false spawn resolves it on PATH
    // with no shell-injection surface from the user's prompt. An override lets
    // a machine with only a .cmd shim point at an explicit launcher.
    this.bin = bin || process.env.CONCOURSE_CLAUDE_BIN || 'claude';
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.capabilities = { permissionCallbacks: false, nativeMultiTurn: false };
  }

  /**
   * Build the exact CLI invocation. Exposed (not inlined) so the debug path can
   * print the equivalent command and tests can assert the flags without a spawn.
   * @param {{ prompt: string, sessionId?: string|null }} opts
   * @returns {string[]}
   */
  buildArgs({ prompt, sessionId }) {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose', // stream-json requires this
      '--include-partial-messages', // token-level deltas require this
      '--allowedTools', 'Read,Glob,Grep,Edit,Write', // conservative; no Bash
      '--permission-mode', 'acceptEdits',
    ];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    return args;
  }

  /**
   * Spawn a turn and yield raw events until the process closes.
   * @param {{ prompt: string, sessionId?: string|null, cwd: string }} opts
   * @returns {AsyncGenerator<RawEvent>}
   */
  async *start({ prompt, sessionId = null, cwd }) {
    const args = this.buildArgs({ prompt, sessionId });
    const child = spawn(this.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    /** @type {RawEvent[]} */
    const queue = [];
    let finished = false;
    /** @type {(() => void)|null} */
    let wake = null;
    const push = (event) => {
      queue.push(event);
      if (wake) { const w = wake; wake = null; w(); }
    };
    const finish = () => {
      finished = true;
      if (wake) { const w = wake; wake = null; w(); }
    };

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        push(JSON.parse(trimmed));
      } catch {
        // A line that isn't JSON is a host-level anomaly, not agent output.
        push({ type: '__parse_error', line: trimmed });
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      // e.g. the executable isn't found. Surface, don't swallow.
      push({ type: '__spawn_error', message: err.message });
      finish();
    });
    child.on('close', (code, signal) => {
      // stdout has ended by now, so all JSON lines are already queued.
      if (stderr.trim()) push({ type: '__stderr', text: stderr.trim() });
      if (code !== 0) push({ type: '__exit', code, signal });
      finish();
    });

    try {
      while (true) {
        while (queue.length) yield queue.shift();
        if (finished) break;
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      this.child = null;
    }
  }

  /**
   * No-op for CliEngine: permissions are decided by the static allowlist, not a
   * runtime callback (§4.1). The approval modal path lives in SdkEngine (v0.2).
   */
  respondToPermission(_requestId, _decision) {
    // intentionally empty
  }

  /** Terminate the in-flight turn. */
  async interrupt() {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }
}

/**
 * Run one turn. Each raw event is normalised (§5) and reduced (§6) into the
 * host-held state, and the projected state is broadcast to every connected
 * browser whenever it changes — this is what makes the turn legible.
 * @param {HostState} hostState
 * @param {string} prompt
 */
export async function runTurn(hostState, prompt) {
  const engine = new CliEngine();
  hostState.activeEngine = engine;

  // The user submitted: move to 'thinking' at once so the UI reacts before the
  // first event lands. Date.now() lives here in the host, never in the pure
  // reducer, so the reducer stays deterministic.
  applyAndBroadcast(hostState, { kind: 'SUBMIT', at: Date.now() });

  try {
    for await (const raw of engine.start({
      prompt,
      sessionId: hostState.sessionId,
      cwd: hostState.workspaceRoot,
    })) {
      if (
        raw && typeof raw === 'object' &&
        typeof raw.session_id === 'string' &&
        raw.session_id !== hostState.sessionId
      ) {
        hostState.sessionId = raw.session_id;
        broadcast(hostState, { type: 'session', sessionId: hostState.sessionId });
      }
      for (const evt of normaliseEvent(raw)) {
        applyAndBroadcast(hostState, evt);
        // The transcript is built from the event stream (§11). Enrich tool steps
        // with the same friendly name the rail uses, so both stay consistent.
        broadcast(hostState, { type: 'event', event: enrichEvent(evt, hostState.workspaceRoot) });
      }
    }
  } catch (err) {
    // An unexpected host-side throw is itself a surfaced failure, not swallowed.
    applyAndBroadcast(hostState, {
      kind: N.HOST_ERROR,
      reason: 'process-exit',
      detail: String((err && err.message) || err),
      fatal: true,
    });
  } finally {
    hostState.activeEngine = null;
  }
}

/**
 * Reduce one event into the held state and broadcast the projection if it
 * changed. Deduping on the serialised projection keeps the 85-odd token deltas
 * of a turn from each producing a redundant frame.
 * @param {HostState} hostState
 * @param {{ kind: string, [k: string]: any }} evt
 */
function applyAndBroadcast(hostState, evt) {
  hostState.turnState = reduceState(hostState.turnState, evt);
  const projected = projectState(hostState.turnState);
  const serialised = JSON.stringify(projected);
  if (serialised !== hostState.lastSentState) {
    hostState.lastSentState = serialised;
    broadcast(hostState, { type: 'state', state: projected });
  }
}

// ---------------------------------------------------------------------------
// Event normalisation (§5)
// ---------------------------------------------------------------------------
//
// Raw engine events → engine-agnostic normalised events, so the reducer never
// sees CLI-shaped data. Two hard rules from the spec:
//   1. Dispatch on event `type`; iterate `content` blocks by their `type`,
//      never by array position (the shape of content varies per turn).
//   2. Any `result` subtype other than success is a surfaced failure, never
//      swallowed.
// One raw event may yield zero, one, or several normalised events.

/** Normalised event kinds (the reducer's vocabulary). */
export const N = {
  SESSION_OPEN: 'SESSION_OPEN',
  NARRATION: 'NARRATION',
  TOOL_START: 'TOOL_START',
  TOOL_END: 'TOOL_END',
  APPROVAL_NEEDED: 'APPROVAL_NEEDED',
  TURN_END: 'TURN_END',
  HOST_ERROR: 'HOST_ERROR',
};

/**
 * @param {RawEvent} raw
 * @returns {object[]} zero or more normalised events
 */
export function normaliseEvent(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return [];

  switch (raw.type) {
    case 'system':
      if (raw.subtype === 'init') {
        return [{
          kind: N.SESSION_OPEN,
          sessionId: raw.session_id ?? null,
          model: raw.model ?? null,
          cwd: raw.cwd ?? null,
          tools: Array.isArray(raw.tools) ? raw.tools : [],
        }];
      }
      // Tolerate every other system subtype: hook_started, hook_response,
      // status, post_turn_summary, api_retry, and any future one.
      return [];

    case 'assistant':
      return normaliseAssistant(raw);

    case 'user':
      return normaliseUser(raw);

    case 'stream_event':
      return normaliseStreamEvent(raw);

    case 'result':
      return [normaliseResult(raw)];

    // Host-internal synthetic events from CliEngine (out-of-band conditions the
    // stream itself can't express). stderr and an unreadable line are surfaced
    // but non-fatal — a successful turn can still print a warning to stderr.
    case '__stderr':
      return [{ kind: N.HOST_ERROR, reason: 'stderr', detail: raw.text ?? '', fatal: false }];
    case '__parse_error':
      return [{ kind: N.HOST_ERROR, reason: 'unreadable-output', detail: raw.line ?? '', fatal: false }];
    case '__exit':
      return [{
        kind: N.HOST_ERROR,
        reason: 'process-exit',
        detail: `exit code ${raw.code}${raw.signal ? ` (${raw.signal})` : ''}`,
        fatal: true,
      }];
    case '__spawn_error':
      return [{ kind: N.HOST_ERROR, reason: 'spawn-failed', detail: raw.message ?? '', fatal: true }];

    // TODO(v0.2, SdkEngine): APPROVAL_NEEDED. The CLI stream has no permission-
    // request event — CliEngine is flag-only (§4.1), so this path is unreachable
    // under it. SdkEngine's permission callback will be adapted into a host-
    // internal `__approval` event whose shape this host defines, which is why we
    // recognise that here rather than guess a CLI API.
    case '__approval':
      return [{
        kind: N.APPROVAL_NEEDED,
        requestId: raw.requestId ?? null,
        tool: raw.tool ?? null,
        input: raw.input ?? null,
      }];

    default:
      // Unknown top-level type (e.g. rate_limit_event) — tolerate, emit nothing.
      return [];
  }
}

/** @param {RawEvent} raw */
function normaliseAssistant(raw) {
  const blocks = raw.message?.content;
  if (!Array.isArray(blocks)) return [];
  const parentToolUseId = raw.parent_tool_use_id ?? null;
  const out = [];
  for (const b of blocks) {
    if (!b || typeof b.type !== 'string') continue;
    if (b.type === 'text') {
      if (typeof b.text === 'string' && b.text.length > 0) {
        out.push({ kind: N.NARRATION, channel: 'speech', text: b.text, partial: false, parentToolUseId });
      }
    } else if (b.type === 'thinking') {
      // Extended-thinking block: the agent's reasoning, surfaced as narration on
      // its own channel so the UI can present it distinctly from prose.
      const text = typeof b.thinking === 'string' ? b.thinking : b.text;
      if (typeof text === 'string' && text.length > 0) {
        out.push({ kind: N.NARRATION, channel: 'thinking', text, partial: false, parentToolUseId });
      }
    } else if (b.type === 'tool_use') {
      out.push({
        kind: N.TOOL_START,
        toolUseId: b.id ?? null,
        tool: b.name ?? null,
        input: b.input ?? {},
        parentToolUseId,
      });
    }
    // other block types: ignored.
  }
  return out;
}

/** @param {RawEvent} raw */
function normaliseUser(raw) {
  const blocks = raw.message?.content;
  if (!Array.isArray(blocks)) return [];
  const parentToolUseId = raw.parent_tool_use_id ?? null;
  const out = [];
  for (const b of blocks) {
    if (b && b.type === 'tool_result') {
      out.push({
        kind: N.TOOL_END,
        toolUseId: b.tool_use_id ?? null,
        isError: b.is_error === true,
        content: b.content ?? null,
        parentToolUseId,
      });
    }
  }
  return out;
}

/** @param {RawEvent} raw */
function normaliseStreamEvent(raw) {
  const ev = raw.event;
  const delta = ev && ev.delta;
  const parentToolUseId = raw.parent_tool_use_id ?? null;
  if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
    return [{ kind: N.NARRATION, channel: 'speech', text: delta.text, partial: true, parentToolUseId }];
  }
  if (delta && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return [{ kind: N.NARRATION, channel: 'thinking', text: delta.thinking, partial: true, parentToolUseId }];
  }
  // message_start / content_block_start / message_stop / etc.: no UI event.
  return [];
}

/** @param {RawEvent} raw */
function normaliseResult(raw) {
  const ok = raw.subtype === 'success' && raw.is_error !== true;
  return {
    kind: N.TURN_END,
    sessionId: raw.session_id ?? null,
    subtype: raw.subtype ?? null,
    ok,
    isError: raw.is_error === true,
    durationMs: raw.duration_ms ?? null,
    numTurns: raw.num_turns ?? null,
    costUsd: raw.total_cost_usd ?? null,
    resultText: typeof raw.result === 'string' ? raw.result : null,
  };
}

// ---------------------------------------------------------------------------
// State machine (§6) — the load-bearing component
// ---------------------------------------------------------------------------
//
// A pure reducer: reduceState(state, event) -> next state. It answers the only
// question the job story cares about — "what is it doing right now and does it
// need me?" — as a coarse state plus plain-language, jargon-free surface text.
// No Date.now() here: elapsed time is the UI's job. `startedAt` is stamped by
// the host and passed in on SUBMIT so the reducer stays deterministic.

const READING_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);
const WRITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** §6.2 tool → coarse state. Anything unmapped (incl. MCP tools) is 'thinking'. */
export function toolToState(tool) {
  if (READING_TOOLS.has(tool)) return 'reading';
  if (WRITING_TOOLS.has(tool)) return 'writing';
  if (tool === 'Bash') return 'running';
  return 'thinking';
}

// Extensions dropped from friendly names (known document types, §6.3).
const DOC_EXTS = new Set([
  'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'pdf',
  'md', 'txt', 'csv', 'rtf', 'odt', 'key', 'pages', 'numbers',
]);

/**
 * §6.3 — a name this audience can read. Workspace-relative, known document
 * extension dropped, separators to spaces, title-cased. The absolute path is
 * kept separately for a tooltip; it never becomes the label.
 * @param {string} absPath
 * @param {string|null} workspaceRoot
 * @returns {{ friendly: string, truePath: string }}
 */
export function friendlyName(absPath, workspaceRoot) {
  const truePath = absPath;
  let rel;
  try {
    rel = workspaceRoot ? path.relative(workspaceRoot, absPath) : absPath;
  } catch {
    rel = absPath;
  }
  // If it escapes the workspace or isn't relative, fall back to the file name.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    rel = path.basename(absPath);
  }
  let base = path.basename(rel);
  const dot = base.lastIndexOf('.');
  if (dot > 0 && DOC_EXTS.has(base.slice(dot + 1).toLowerCase())) {
    base = base.slice(0, dot);
  }
  const friendly = base
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
  return { friendly: friendly || base, truePath };
}

/** First file-ish path in a tool input, or null (Glob/Grep have none). */
function fileOf(input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path || input.notebook_path || input.path || null;
}

/** Dedupe files touched by true path; an edit supersedes a read. */
function recordFile(list, entry) {
  const idx = list.findIndex((f) => f.truePath === entry.truePath);
  if (idx === -1) return [...list, entry];
  if (entry.action === 'edited' && list[idx].action !== 'edited') {
    const copy = list.slice();
    copy[idx] = entry;
    return copy;
  }
  return list;
}

/** Plain-language reason for a failed turn. Raw text goes in `detail`. */
function friendlyFailure(evt) {
  switch (evt.subtype) {
    case 'error_max_turns':
      return 'It reached the limit on how many steps it could take.';
    case 'error_during_execution':
      return 'It ran into a problem while working and had to stop.';
    default:
      return 'It stopped before finishing.';
  }
}

/** Plain-language reason for a host-level failure. Raw text goes in `detail`. */
function friendlyHostError(evt) {
  switch (evt.reason) {
    case 'spawn-failed':
      return "Couldn't start the assistant. It may not be installed correctly.";
    case 'process-exit':
      return 'The assistant stopped unexpectedly.';
    default:
      return 'Something went wrong.';
  }
}

/** @param {string|null} workspaceRoot */
export function createInitialState(workspaceRoot = null) {
  return {
    state: 'idle',
    activity: 'Ready',
    friendlyName: null,
    truePath: null,
    narration: '',
    filesTouched: [],
    reason: null,
    detail: null,
    note: null,
    sessionId: null,
    model: null,
    approval: null,
    turn: null,
    resultText: null,
    startedAt: null,
    workspaceRoot,
    currentToolUseId: null,
  };
}

/**
 * The §6 transition function. `SUBMIT` is a host-originated action (the user
 * sent a prompt); every other kind is a normalised engine event.
 * @param {ReturnType<typeof createInitialState>} state
 * @param {{ kind: string, [k: string]: any }} evt
 */
export function reduceState(state, evt) {
  if (!evt || typeof evt.kind !== 'string') return state;

  switch (evt.kind) {
    case 'SUBMIT':
      // idle / done / blocked → thinking. Fresh turn: clear last turn's traces.
      return {
        ...state,
        state: 'thinking',
        activity: 'Working out how to do this',
        friendlyName: null,
        truePath: null,
        narration: '',
        filesTouched: [],
        reason: null,
        detail: null,
        note: null,
        approval: null,
        turn: null,
        resultText: null,
        startedAt: evt.at ?? null,
        currentToolUseId: null,
      };

    case N.SESSION_OPEN:
      return {
        ...state,
        sessionId: evt.sessionId ?? state.sessionId,
        model: evt.model ?? state.model,
      };

    case N.NARRATION:
      // Prose only; the coarse state is unchanged (deltas stream while thinking).
      return { ...state, narration: evt.partial ? state.narration + evt.text : evt.text };

    case N.TOOL_START: {
      const s = toolToState(evt.tool);
      const next = { ...state, state: s, currentToolUseId: evt.toolUseId ?? null };
      if (s === 'reading' || s === 'writing') {
        const abs = fileOf(evt.input);
        if (abs) {
          const fn = friendlyName(abs, state.workspaceRoot);
          next.friendlyName = fn.friendly;
          next.truePath = fn.truePath;
          next.activity = (s === 'reading' ? 'Reading ' : 'Editing ') + fn.friendly;
        } else {
          next.friendlyName = null;
          next.truePath = null;
          next.activity = s === 'reading' ? 'Looking through your files' : 'Saving your changes';
        }
      } else if (s === 'running') {
        next.friendlyName = null;
        next.truePath = null;
        next.activity = 'Running a command';
      } else {
        next.friendlyName = null;
        next.truePath = null;
        next.activity = 'Working on it';
      }
      return next;
    }

    case N.TOOL_END: {
      // Only the end of the tool currently in flight advances the machine. A
      // TOOL_END whose id doesn't match the active tool — out-of-order arrival,
      // a duplicate, or a replayed buffered stream (§7 reconnect) — is ignored,
      // so it can't wrongly reset to 'thinking' or misattribute filesTouched.
      // When either id is absent we fall back to the ordered-stream assumption.
      if (
        state.currentToolUseId != null &&
        evt.toolUseId != null &&
        evt.toolUseId !== state.currentToolUseId
      ) {
        return state;
      }
      // Record the file the just-finished tool touched, then return to thinking.
      let filesTouched = state.filesTouched;
      if ((state.state === 'reading' || state.state === 'writing') && state.friendlyName) {
        filesTouched = recordFile(filesTouched, {
          friendlyName: state.friendlyName,
          truePath: state.truePath,
          action: state.state === 'reading' ? 'read' : 'edited',
        });
      }
      return {
        ...state,
        state: 'thinking',
        activity: 'Working out what to do next',
        friendlyName: null,
        truePath: null,
        currentToolUseId: null,
        filesTouched,
      };
    }

    case N.APPROVAL_NEEDED:
      return {
        ...state,
        state: 'awaiting_approval',
        activity: 'Needs your OK',
        approval: { requestId: evt.requestId, tool: evt.tool, input: evt.input },
      };

    case N.TURN_END:
      if (evt.ok) {
        return {
          ...state,
          state: 'done',
          activity: 'Finished',
          reason: null,
          detail: null,
          turn: { durationMs: evt.durationMs, costUsd: evt.costUsd, numTurns: evt.numTurns },
          resultText: evt.resultText ?? null,
        };
      }
      return {
        ...state,
        state: 'blocked',
        activity: "Stopped — here's what went wrong",
        reason: friendlyFailure(evt),
        detail: evt.resultText ?? null,
      };

    case N.HOST_ERROR:
      if (evt.fatal) {
        return {
          ...state,
          state: 'blocked',
          activity: "Stopped — here's what went wrong",
          reason: friendlyHostError(evt),
          detail: evt.detail ?? null,
        };
      }
      // Non-fatal (e.g. a stderr warning on an otherwise-fine turn): surface as
      // a note, never change the state — it must not override a coming 'done'.
      return { ...state, note: evt.detail ?? null };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// WorkspaceFs (§11) — the scoped file surface
// ---------------------------------------------------------------------------
//
// Every client-supplied path is resolved against the workspace root and
// rejected if it escapes — lexically (`../`, an absolute path) OR through a
// symlink that points out of the root. This is the one security control that
// matters in v0.1 (loopback bind covers the rest, §11), so it is deliberately
// strict and every path endpoint is traversal-tested.

/** An error carrying the HTTP status the API should answer with. */
export class WorkspaceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}

/** True if `to` is not contained within `from`. */
function escapesRoot(from, to) {
  const rel = path.relative(from, to);
  return rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel));
}

export class WorkspaceFs {
  /** @param {string} workspaceRoot must already exist */
  constructor(workspaceRoot) {
    this.root = path.resolve(workspaceRoot);
    // Real (symlink-resolved) root, so symlink checks compare like with like.
    this.realRoot = fs.realpathSync(this.root);
  }

  /** Lexical containment. Throws 403 if the requested path escapes the root. */
  resolve(relPath) {
    if (relPath != null && typeof relPath !== 'string') {
      throw new WorkspaceError('Invalid path.', 400);
    }
    const abs = path.resolve(this.root, relPath || '');
    if (escapesRoot(this.root, abs)) {
      throw new WorkspaceError('That location is outside your workspace.', 403);
    }
    return abs;
  }

  /** Lexical + symlink containment. Requires the target to exist. */
  realResolve(relPath) {
    const abs = this.resolve(relPath);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new WorkspaceError('Not found.', 404);
      throw e;
    }
    if (escapesRoot(this.realRoot, real)) {
      // a symlink inside the workspace that resolves outside it
      throw new WorkspaceError('That location is outside your workspace.', 403);
    }
    return real;
  }

  /** List a directory as friendly entries (§11). */
  list(relPath) {
    const abs = this.realResolve(relPath);
    let dirents;
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === 'ENOTDIR') throw new WorkspaceError('That is a file, not a folder.', 400);
      throw e;
    }
    return dirents.map((d) => {
      const full = path.join(abs, d.name);
      let size = 0;
      let mtime = 0;
      let kind = d.isDirectory() ? 'directory' : 'file';
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
        kind = st.isDirectory() ? 'directory' : 'file';
      } catch {
        // broken symlink or vanished entry: report the name with what we have
      }
      return { name: d.name, kind, size, mtime, friendlyName: friendlyName(full, this.root).friendly };
    });
  }

  /** Read a file as text, capped. Returns { text, truncated, size }. */
  readTextCapped(relPath, cap) {
    const abs = this.realResolve(relPath);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new WorkspaceError('That is a folder, not a file.', 400);
    const length = Math.min(st.size, cap);
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, 0);
      return { text: buf.toString('utf8'), truncated: st.size > cap, size: st.size };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Absolute real path of a file for download. Throws for a directory. */
  fileForDownload(relPath) {
    const abs = this.realResolve(relPath);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new WorkspaceError('That is a folder, not a file.', 400);
    return abs;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Start the host: resolve config, build the app, attach the socket, listen.
 * @returns {{ server: http.Server, hostState: HostState, wss: WebSocketServer }}
 */
export function startHost() {
  const workspaceRoot = ensureWorkspace(resolveWorkspaceRoot());
  const hostState = createHostState(workspaceRoot);
  const app = createApp(hostState);
  const server = http.createServer(app);
  const wss = attachSessionSocket(server, hostState);

  server.listen(PORT, HOST, () => {
    console.log(`Concourse host listening on http://${HOST}:${PORT}`);
    console.log(`Workspace: ${workspaceRoot}`);
  });

  return { server, hostState, wss };
}

// Only start the server when run directly (`node host.mjs` / `npm start`),
// never when imported by a test. This is what keeps the pure functions in
// later units unit-testable.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startHost();
}
