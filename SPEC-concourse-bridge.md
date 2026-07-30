# SPEC-Sxx — Concourse: Non-Terminal Bridge to Claude Code

> **Spec number reserved, not assigned.** S81 (TIMC Light spec-health port), S82 (federation),
> S83 (tenancy/fingerprints) are already taken. Assign this one before the first commit and
> replace `Sxx` throughout.

**Status:** Draft for implementation
**Owner:** James
**Implementer:** Claude Code session (see `CLAUDE.md`)
**Depends on:** nothing in the CCQG corpus. Deliberately standalone.

---

## 1. Job Story

> When I am a product manager, UX designer, or business leader who has been given Claude Code
> access, I want to direct an agent against my working files and see what it is doing, so I can
> produce real artifacts without ever opening a terminal or learning developer workflow.

The failure mode this replaces: a capable agent behind an interface that offers no undo, no
visible state, and no signal about whether it is thinking, waiting on the user, or stuck.

**This spec is about surfacing state, not about hiding the terminal.** A reskin that streams the
same raw text in nicer colours fails the job story. If the UI cannot answer "what is it doing
right now and does it need me?" at a glance, the build has missed.

---

## 2. Scope

### 2.1 In scope (v0.1, the two-file proof)

- Single Node host process, loopback-bound, wrapping one Claude Code agent loop.
- Single self-contained HTML file, no build step, served by the host.
- Turn-level state machine derived from agent events, rendered as status — not as a log tail.
- Session continuity across turns and across a browser refresh.
- Scoped file browser rooted at one configured workspace directory.
- Auto-surfacing of files written to the workspace `outputs/` directory.
- Tool-approval prompts rendered as a UI modal, not a terminal prompt.

### 2.2 Explicitly out of scope (v0.1)

| Out | Why | Where it lands later |
|---|---|---|
| Multi-user, network hosting | Loopback bind *is* the auth model for v0.1 | v0.3, needs real identity |
| Git operations | RULE 4 — git stays host-side and human-driven | never in Concourse |
| MCP server configuration UI | Inherit the workspace `.mcp.json` as-is | v0.2 |
| Electron / installer packaging | Proof runs from `npm start` | v0.2 |
| Role-based tool allowlists | Design them in v0.1 config, enforce in v0.2 | §8 |
| Skill provisioning | Artifactory CLI already solves this | §9 |
| FINRA 4511 retention | Hook point specified, not implemented | §10 |

### 2.3 Non-goals

Concourse is not an IDE, not a code editor, and not a replacement for Claude Code for engineers.
Engineers keep the terminal. Concourse exists for the population that will never use it.

---

## 3. Architecture

```
  ┌──────────────────────────────────────────────┐
  │  app.html                                     │
  │  React via CDN, no bundler, single file       │
  │  ┌────────────┬───────────────┬────────────┐ │
  │  │ StatusRail │ TurnTranscript│ FileTray   │ │
  │  └────────────┴───────────────┴────────────┘ │
  └───────────────────┬──────────────────────────┘
                      │ WebSocket  ws://127.0.0.1:7317/session
                      │ REST       GET /files, GET /file, GET /download
  ┌───────────────────▼──────────────────────────┐
  │  host.mjs   (Node 20+, express + ws)          │
  │  ┌─────────────────────────────────────────┐ │
  │  │ EventNormaliser → StateReducer          │ │
  │  ├─────────────────────────────────────────┤ │
  │  │ IAgentEngine  (loose coupler)           │ │
  │  │   ├── CliEngine    (spawn claude -p)    │ │
  │  │   └── SdkEngine    (Agent SDK query())  │ │
  │  ├─────────────────────────────────────────┤ │
  │  │ WorkspaceFs (scoped, deny traversal)    │ │
  │  │ TranscriptSink (append-only JSONL)      │ │
  │  └─────────────────────────────────────────┘ │
  └───────────────────┬──────────────────────────┘
                      │
              workspace filesystem
              (configured root, e.g. ~/Documents/ClaudeWorkspace)
```

The browser cannot spawn a process. The Node host is the irreducible piece — accept it and keep
it thin. Everything the host does beyond process management and event normalisation is scope
creep.

---

## 4. Engine Abstraction

Two viable engines. Build the interface first so the choice stays reversible — same loose-coupler
pattern as `ITerminalAdapter` in the FlowTrain dual-terminal work.

```ts
interface IAgentEngine {
  start(opts: { prompt: string; sessionId?: string; cwd: string }): AsyncIterable<RawEvent>;
  respondToPermission(requestId: string, decision: 'allow' | 'deny'): void;
  interrupt(): Promise<void>;
  capabilities: { permissionCallbacks: boolean; nativeMultiTurn: boolean };
}
```

### 4.1 CliEngine — day-one proof

Spawn the CLI and consume newline-delimited JSON from stdout:

```
claude -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --allowedTools "Read,Glob,Grep,Edit,Write" \
  --permission-mode acceptEdits \
  [--resume <sessionId>]
```

- `stream-json` requires `--verbose`. Token-level deltas additionally require
  `--include-partial-messages`. Omitting either silently degrades the UX to batch-at-end.
- One process per turn. Multi-turn is achieved by capturing `session_id` and passing `--resume`.
- **Limitation that decides the roadmap:** permission handling is flag-only. There is no callback
  to intercept, so §6.4 (approval modal) cannot be fully honoured. CliEngine must therefore run
  with a conservative static allowlist and no `Bash`.
- **Never** `--dangerously-skip-permissions`. This host runs on a real workstation with real
  documents. The blast radius is the user's home directory.

### 4.2 SdkEngine — the real build

Use the Agent SDK (`query()`), which runs the same engine as the CLI but as a library inside the
host process. This is the target because it gives:

- native multi-turn without process churn,
- a permission callback, which is the *entire reason* a non-developer will trust this tool,
- hooks and subagents,
- provider routing (Anthropic API / Bedrock / Vertex) without touching Concourse code.

**Verify against current docs before writing SDK code** — the SDK surface has moved (it was
renamed from the Claude Code SDK) and this spec should not be trusted over
`https://docs.claude.com/en/docs/claude-code/overview`. Check the exact function signature,
package name, and the permission-callback parameter name. Do not guess.

### 4.3 Decision

Ship `CliEngine` in v0.1 to prove the state machine against real event traffic. Ship `SdkEngine`
in v0.2 and make it the default. Keep `CliEngine` permanently as the debug path — being able to
print the exact equivalent command is worth the maintenance.

---

## 5. Event Normalisation

The engine emits raw events. Normalise before the reducer sees them so the reducer is engine-agnostic.

| Raw event | Carries | Normalised |
|---|---|---|
| `system` / init | `session_id`, model, cwd, tools | `SESSION_OPEN` |
| `assistant` w/ text block | prose, possibly partial | `NARRATION` |
| `assistant` w/ tool_use block | tool name, input | `TOOL_START` |
| `user` w/ tool_result block | result, `is_error` | `TOOL_END` |
| permission request | tool, input, requestId | `APPROVAL_NEEDED` |
| `result` | `session_id`, cost, duration, subtype | `TURN_END` |
| stderr / non-zero exit | text | `HOST_ERROR` |

Two hard rules for the implementer:

1. **Dispatch on event type, never on array position.** The shape of `content` varies by turn.
2. **Treat any `result` subtype other than success as a surfaced failure, not something to
   swallow.** The user must see that the turn failed and why.

---

## 6. State Machine

This is the load-bearing component. Everything else is plumbing.

```
                  ┌─────────┐
      ┌──────────►│  idle   │◄─────────────┐
      │           └────┬────┘              │
      │                │ user submits      │
      │           ┌────▼─────┐             │
      │      ┌────┤ thinking ├────┐        │
      │      │    └────┬─────┘    │        │
      │      │         │          │        │
      │ ┌────▼───┐ ┌───▼────┐ ┌───▼─────┐  │
      │ │reading │ │writing │ │ running │  │
      │ └────┬───┘ └───┬────┘ └───┬─────┘  │
      │      └─────────┼──────────┘        │
      │                │                   │
      │        ┌───────▼──────────┐        │
      │        │ awaiting_approval│        │
      │        └───────┬──────────┘        │
      │                │                   │
      │   ┌────────────┴─────────┐         │
      └───┤ done         blocked ├─────────┘
          └──────────────────────┘
```

### 6.1 States and what the UI must say

| State | Plain-language surface | Colour |
|---|---|---|
| `idle` | "Ready" | neutral |
| `thinking` | "Working out how to do this" | blue, animated |
| `reading` | "Reading `<friendly filename>`" | blue |
| `writing` | "Editing `<friendly filename>`" | amber |
| `running` | "Running a command" + plain-language gloss | amber |
| `awaiting_approval` | "Needs your OK" + modal | **red, must interrupt** |
| `blocked` | "Stopped — here's what went wrong" | red |
| `done` | "Finished" + duration + files touched | green |

### 6.2 Tool → state mapping

- `Read`, `Glob`, `Grep`, `NotebookRead` → `reading`
- `Edit`, `Write`, `MultiEdit`, `NotebookEdit` → `writing`
- `Bash` → `running`
- anything else, including MCP tools → `thinking` with the tool's own description as the label

### 6.3 Friendly filenames

Never show an absolute path to this audience. Render workspace-relative, drop the extension for
known document types, and title-case. `~/ws/outputs/q3_board_deck.pptx` → "Q3 Board Deck".
Keep the true path in a tooltip.

### 6.4 Approval modal

When `APPROVAL_NEEDED` arrives, the transcript dims and a modal takes focus. It must state, in
one sentence and without jargon, what the agent wants to do and what changes if it is allowed.
Two buttons, no default focus, no timeout, no "remember this choice" in v0.1.

If the engine is `CliEngine`, this path is unreachable — the allowlist decided in advance. Ship
the component anyway; it is the reason `SdkEngine` exists.

---

## 7. Session Continuity

- Capture `session_id` from `SESSION_OPEN`, hold it in host memory.
- Persist `{ sessionId, startedAt, workspaceRoot, turnCount }` to
  `<workspaceRoot>/.concourse/session.json` after every `TURN_END`.
- On browser reconnect, the host replays the normalised event log for the current session so a
  refresh does not lose the thread.
- On host restart, offer "Continue where you left off" using the persisted `sessionId` with
  `--resume`. Do not auto-resume silently — a stale resume is confusing.

The event log is capped in memory (last 500 normalised events) with the full stream going to the
transcript sink. Do not stream a whole session back into the browser on reconnect.

---

## 8. Role Configuration

Design the shape in v0.1 even though enforcement lands in v0.2, because the shape determines
whether the Artifactory skill channel can drive it.

```json
// roles/pm.json
{
  "role": "pm",
  "label": "Product Manager",
  "workspaceRoot": "~/Documents/ClaudeWorkspace",
  "allowedTools": ["Read", "Glob", "Grep", "Edit", "Write"],
  "deniedTools": ["Bash"],
  "skills": ["discovery-brief@^2.1", "job-story-writer@^1.4"],
  "mcpServers": ["atlassian", "sharepoint"],
  "approvalPolicy": "prompt-on-write-outside-outputs"
}
```

`skills` entries are Artifactory coordinates resolved by the existing custom CLI at provision
time, not at runtime. Concourse never reaches for a marketplace. See §9.

Three roles for v0.1: `pm`, `ux`, `exec`. `exec` is read-only plus document generation — no
`Edit` on anything outside `outputs/`.

---

## 9. Skill Provisioning

**Do not build a skill installer.** The Artifactory-backed channel with its custom pull/install
CLI is the one distribution path in the org that demonstrably works. Concourse's only obligation
is to invoke it at provision time and then read what lands on disk.

Provisioning contract:

1. Operator runs the existing CLI against a role manifest.
2. Skills land in `<workspaceRoot>/.claude/skills/<name>/SKILL.md`.
3. Concourse starts. Claude Code discovers them natively via frontmatter `description`.
4. Concourse displays the resolved skill list read-only in a "What this assistant can do" panel,
   built from the frontmatter `name` and `description`.

That panel is the forcing function on skill-writing quality. A skill whose `description` reads
badly to a PM in a UI panel is a skill whose `description` will also fail to trigger. The panel
makes the standard visible without writing a style guide.

---

## 10. Compliance Hook (FINRA 4511)

Not implemented in v0.1. Specified so it is not retrofitted awkwardly.

`TranscriptSink` writes append-only JSONL to `<workspaceRoot>/.concourse/transcripts/<sessionId>.jsonl`,
one normalised event per line, wall-clock timestamped, never rewritten and never truncated.
`session_id` is the correlation key against any downstream retention store.

Two things the implementer must not do: do not make the sink lossy under backpressure, and do not
let a sink write failure be swallowed — a failed audit write is a hard stop, not a warning. The
WORM target is a later decision and does not belong in this spec.

---

## 11. HTTP / WS Contract

```
GET  /                          → app.html
WS   /session                   → bidirectional event channel
GET  /api/files?path=<rel>      → { entries: [{ name, kind, size, mtime, friendlyName }] }
GET  /api/file?path=<rel>       → text content, capped at 1 MB
GET  /api/download?path=<rel>   → binary, Content-Disposition attachment
GET  /api/role                  → resolved role config + skill list
```

WS messages, browser → host:

```json
{ "type": "submit",   "prompt": "..." }
{ "type": "approve",  "requestId": "...", "decision": "allow" | "deny" }
{ "type": "interrupt" }
```

WS messages, host → browser: normalised events from §5 plus `{ "type": "state", "state": "..." }`.

**Path safety:** every `path` parameter resolves against `workspaceRoot` and is rejected if the
resolved real path escapes it. Reject symlinks that leave the root. This is the only security
control in v0.1 that actually matters, because loopback binding covers the rest.

---

## 12. Front End

Constraints, in priority order:

1. **One file, no build step.** React from a CDN as ESM inside `<script type="module">`. If a
   bundler appears in this project, the spec has been violated.
2. **State legible from three metres.** The StatusRail is the primary element, not the transcript.
3. **No developer vocabulary in any user-visible string.** No "stdout", "tool call", "token",
   "diff", "commit", "stderr", "exit code".
4. Target under ~1500 lines. If it grows past that, cut features, not clarity.

Three regions:

- **StatusRail** (top, fixed) — current state, animated when active, elapsed time, interrupt button.
- **TurnTranscript** (centre) — narration and completed steps as collapsed cards, newest last.
  Tool activity collapses to one line per step once complete. Raw output is behind a disclosure
  that is closed by default and never auto-opens.
- **FileTray** (right) — the scoped file browser, with anything newly written to `outputs/`
  pinned to the top with a download button and a "new" marker.

Read `/mnt/skills/public/frontend-design/SKILL.md` before writing any of this. Do not ship the
default-bootstrap look; this tool's entire value proposition is that it does not feel like a
developer tool.

---

## 13. Acceptance Criteria

v0.1 is done when all of these hold on both macOS and Windows:

1. `npm start` launches the host and opens the browser. No terminal interaction after that point.
2. A prompt that reads three files and writes one produces visible `reading` → `writing` → `done`
   transitions, with correct friendly filenames at each step.
3. A prompt that fails mid-turn lands in `blocked` with a plain-language reason. Nothing is
   swallowed.
4. Killing the browser tab and reopening it restores the current session with its transcript.
5. A file written to `outputs/` appears pinned in the FileTray within 2s and downloads correctly.
6. `../` and symlink traversal in any `path` parameter returns 403.
7. A non-developer completes a real task end-to-end without asking what a word means.
   **This is the criterion that counts.** Recruit one PM. If they ask, the copy is wrong.
8. Every turn appears in the session JSONL, one event per line, append-only.

---

## 14. Trade-offs Made Explicit

| Decision | Bought | Paid |
|---|---|---|
| Node host rather than pure browser | Actually works | An install step, a running process |
| CLI engine first | Real event traffic on day one | No approval modal until v0.2 |
| Single-file HTML, no bundler | Auditable, hackable, ships today | No component library, manual state |
| Loopback-only | No auth to build or get wrong | Single user, single machine |
| State machine over log tail | The actual job story | Mapping to maintain as tools change |
| Reusing the Artifactory channel | Zero new distribution to fight for | Coupled to that CLI's release cadence |

---

## 15. What to Revisit

- **If PMs ask for `Bash`,** do not grant it. Find the specific task and wrap it as a skill with
  a narrow tool surface instead. `Bash` in this audience's hands is the failure mode that ends
  the pilot.
- **If two people want to share a session,** stop and design properly. Do not bolt a second
  websocket onto v0.1.
- **If the state mapping in §6.2 needs a fourth branch,** the tool taxonomy has shifted and the
  mapping should move to config.
- **If the MCP-App-in-Copilot path gets funded,** this host becomes the MCP server behind it and
  `app.html` is discarded. Keep the engine and normaliser clean enough that this costs a week,
  not a rewrite.
