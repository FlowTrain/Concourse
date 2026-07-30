# CLAUDE.md — Concourse

Read `SPEC-concourse-bridge.md` before writing anything. Read `.claude/soul.md` for why this
exists; it will stop you from optimising the wrong thing.

## What this is

A local Node host plus a single-file HTML front end that lets product managers, designers, and
business leaders drive a Claude Code agent loop without a terminal. Two files in v0.1:
`host.mjs` and `app.html`.

## Stack

- Node 20+, ESM only. `express` and `ws`. No TypeScript build step in v0.1.
- Front end: React from a CDN as ESM. **No bundler.** If you find yourself adding Vite, stop.
- No database. JSON sidecars under `<workspaceRoot>/.concourse/`.

## Verify before you code

The Claude Code CLI flags and the Agent SDK surface have both moved recently. The spec records
what was true when it was written, not necessarily what is true now.

- Check `https://docs.claude.com/en/docs/claude-code/overview` and the headless-mode page for the
  current `--output-format stream-json` event shapes and flag names.
- Check the current Agent SDK package name and `query()` signature before writing `SdkEngine`.
- **Do not guess a parameter name.** If the docs are ambiguous, write the CLI path and leave a
  clearly marked TODO rather than inventing an API.

## Standing rules

1. **RULE 4 — git is host-side.** Do not run `git commit`, `git push`, or any branch operation.
   Stage nothing. Tell me what to commit and I will do it.
2. **GH-### issue refs.** Reference issues as `GH-123` in commit messages you draft for me.
3. **Ledger append per unit.** Append one row to `BUILD-LEDGER.md` per completed unit of work:
   `| <date> | <unit> | <files touched> | <acceptance criteria met> |`.
4. **One unit at a time.** Finish and report before starting the next. Do not batch four units
   and present a wall of diffs.
5. **Never `--dangerously-skip-permissions`** anywhere in this codebase, including examples,
   comments, and test fixtures. This host runs against a real user's documents directory.

## Build order

Do not deviate. Each step is independently demonstrable.

1. `host.mjs` skeleton — express, static serve, ws upgrade, health check. Prove the socket.
2. `CliEngine` — spawn, consume NDJSON, emit `RawEvent`. Log raw events to console only.
3. `EventNormaliser` — §5 of the spec. Unit-test the mapping table with recorded fixtures.
4. `StateReducer` — §6. Unit-test every transition including the failure paths.
5. `app.html` StatusRail only. Nothing else. Prove state is legible before building transcript.
6. `TurnTranscript`.
7. `WorkspaceFs` + REST endpoints + path-escape rejection tests.
8. `FileTray`.
9. `TranscriptSink`.
10. Session persistence and reconnect replay.

`SdkEngine` and the approval modal are v0.2. Do not start them in this session.

## Design constraints you must not relax

- **No developer vocabulary in user-visible strings.** Not "stdout", "tool call", "diff",
  "token", "exit code", "stderr", "commit". If you need a word for something and the plain-English
  version is clumsy, flag it for me rather than falling back to the technical term.
- **Absolute paths never reach the UI.** Workspace-relative and friendly-cased only. True path
  goes in a tooltip.
- **Raw output is always behind a closed disclosure.** It never auto-expands, not even on error.
- Read `/mnt/skills/public/frontend-design/SKILL.md` before `app.html`. The default look defeats
  the purpose of the project.

## Testing

- Fixtures over live calls. Record one real NDJSON session to `fixtures/session-*.ndjson` and
  drive the normaliser and reducer tests from it. Do not burn tokens re-running the agent to test
  the parser.
- Node's built-in test runner. No Jest.
- Every path-parameter endpoint gets a traversal test. This is the only security control that
  matters in v0.1.

## When you are stuck

Say so and stop. Do not:

- widen a tool allowlist to make something work,
- add a dependency to route around a small amount of code,
- implement a v0.2 item because v0.1 felt incomplete,
- refactor the spec's architecture because you found a tidier shape — raise it with me instead.

## Definition of done for this session

Acceptance criteria 1 through 6 and 8 in §13 of the spec, on macOS. Criterion 7 needs a real
person and is mine to arrange. Criterion 8's Windows pass is v0.2.
