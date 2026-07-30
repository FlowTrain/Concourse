// Unit tests for the EventNormaliser (§5), driven from a recorded real session
// so the mapping is asserted against genuine CLI output, not invented shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseEvent, enrichEvent, redactWorkspacePaths, N } from '../host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'session-readwrite.ndjson');

/** Parse the fixture and flatten every raw line through the normaliser. */
function normaliseFixture() {
  const raw = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  for (const line of raw) {
    for (const evt of normaliseEvent(JSON.parse(line))) out.push(evt);
  }
  return out;
}

test('fixture: exactly one SESSION_OPEN carrying session/model/cwd/tools', () => {
  const evts = normaliseFixture();
  const opens = evts.filter((e) => e.kind === N.SESSION_OPEN);
  assert.equal(opens.length, 1);
  const [open] = opens;
  assert.match(open.sessionId, /^[0-9a-f-]{36}$/);
  assert.ok(open.model, 'model present');
  assert.ok(open.cwd, 'cwd present');
  assert.ok(Array.isArray(open.tools) && open.tools.length > 0, 'tools present');
});

test('fixture: a Read TOOL_START on notes.txt precedes a Write TOOL_START', () => {
  const evts = normaliseFixture();
  const starts = evts.filter((e) => e.kind === N.TOOL_START);
  const read = starts.find((e) => e.tool === 'Read');
  const write = starts.find((e) => e.tool === 'Write');
  assert.ok(read, 'saw a Read tool start');
  assert.ok(write, 'saw a Write tool start');
  assert.match(String(read.input.file_path), /notes\.txt$/);
  assert.ok(read.toolUseId, 'tool_use id carried through');
  // Ordering: the read is dispatched before the write.
  assert.ok(evts.indexOf(read) < evts.indexOf(write));
});

test('fixture: every TOOL_START is matched by a non-error TOOL_END', () => {
  const evts = normaliseFixture();
  const ends = evts.filter((e) => e.kind === N.TOOL_END);
  assert.ok(ends.length >= 1, 'at least one TOOL_END');
  for (const end of ends) {
    assert.equal(end.isError, false);
    assert.ok(end.toolUseId, 'tool_use id carried through');
  }
});

test('fixture: exactly one successful TURN_END with cost + duration', () => {
  const evts = normaliseFixture();
  const ends = evts.filter((e) => e.kind === N.TURN_END);
  assert.equal(ends.length, 1);
  const [end] = ends;
  assert.equal(end.subtype, 'success');
  assert.equal(end.ok, true);
  assert.equal(end.isError, false);
  assert.equal(typeof end.durationMs, 'number');
  assert.equal(typeof end.costUsd, 'number');
});

test('fixture: partial NARRATION arrives from stream deltas', () => {
  const evts = normaliseFixture();
  const partial = evts.filter((e) => e.kind === N.NARRATION && e.partial === true);
  assert.ok(partial.length > 0, 'saw streamed text deltas as partial narration');
});

test('fixture: no HOST_ERROR on a clean successful run', () => {
  const evts = normaliseFixture();
  assert.equal(evts.filter((e) => e.kind === N.HOST_ERROR).length, 0);
});

// --- Synthetic cases: paths the happy-path fixture cannot exercise ----------

test('a non-success result subtype is a surfaced failure, not swallowed', () => {
  const evts = normaliseEvent({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: 'x',
    duration_ms: 5,
    result: 'something broke',
  });
  assert.equal(evts.length, 1);
  assert.equal(evts[0].kind, N.TURN_END);
  assert.equal(evts[0].ok, false);
  assert.equal(evts[0].isError, true);
  assert.equal(evts[0].subtype, 'error_during_execution');
});

test('non-zero exit and spawn failure are fatal HOST_ERRORs', () => {
  const [exit] = normaliseEvent({ type: '__exit', code: 1, signal: null });
  assert.equal(exit.kind, N.HOST_ERROR);
  assert.equal(exit.fatal, true);
  assert.equal(exit.reason, 'process-exit');

  const [spawn] = normaliseEvent({ type: '__spawn_error', message: 'ENOENT' });
  assert.equal(spawn.kind, N.HOST_ERROR);
  assert.equal(spawn.fatal, true);
  assert.equal(spawn.reason, 'spawn-failed');
});

test('stderr and unreadable lines are non-fatal HOST_ERRORs', () => {
  const [err] = normaliseEvent({ type: '__stderr', text: 'Warning: proceeding without stdin' });
  assert.equal(err.kind, N.HOST_ERROR);
  assert.equal(err.fatal, false);
  assert.equal(err.reason, 'stderr');

  const [parse] = normaliseEvent({ type: '__parse_error', line: '{not json' });
  assert.equal(parse.kind, N.HOST_ERROR);
  assert.equal(parse.fatal, false);
});

test('a host-internal approval event maps to APPROVAL_NEEDED', () => {
  const [evt] = normaliseEvent({
    type: '__approval',
    requestId: 'req-1',
    tool: 'Write',
    input: { file_path: 'x.txt' },
  });
  assert.equal(evt.kind, N.APPROVAL_NEEDED);
  assert.equal(evt.requestId, 'req-1');
  assert.equal(evt.tool, 'Write');
});

test('one assistant message with [text, tool_use] yields both, in order', () => {
  const evts = normaliseEvent({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Let me read that file.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } },
    ] },
    parent_tool_use_id: null,
  });
  assert.equal(evts.length, 2);
  assert.equal(evts[0].kind, N.NARRATION);
  assert.equal(evts[1].kind, N.TOOL_START);
  assert.equal(evts[1].tool, 'Read');
});

test('narration carries a channel: prose is speech, extended thinking is thinking', () => {
  // Speech from a streamed text delta
  const [speech] = normaliseEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading now' } },
  });
  assert.equal(speech.kind, N.NARRATION);
  assert.equal(speech.channel, 'speech');
  assert.equal(speech.partial, true);

  // Reasoning from a streamed thinking delta
  const [thinkDelta] = normaliseEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me consider…' } },
  });
  assert.equal(thinkDelta.kind, N.NARRATION);
  assert.equal(thinkDelta.channel, 'thinking');
  assert.equal(thinkDelta.text, 'Let me consider…');
  assert.equal(thinkDelta.partial, true);

  // Reasoning from a full thinking block on an assistant message
  const [thinkBlock] = normaliseEvent({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'Weighing the options.' }] },
    parent_tool_use_id: null,
  });
  assert.equal(thinkBlock.kind, N.NARRATION);
  assert.equal(thinkBlock.channel, 'thinking');
  assert.equal(thinkBlock.text, 'Weighing the options.');
  assert.equal(thinkBlock.partial, false);
});

test('enrichEvent adds a friendly name to a tool step and caps a large result', () => {
  const ws = '/ws';
  const [start] = normaliseEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/ws/q3_board_deck.pptx' } }] },
    parent_tool_use_id: null,
  });
  const enriched = enrichEvent(start, ws);
  assert.equal(enriched.friendly, 'Q3 Board Deck');
  assert.equal(enriched.truePath, '/ws/q3_board_deck.pptx');

  // TOOL_END content (array of blocks) is flattened to text and capped.
  const end = { kind: N.TOOL_END, toolUseId: 't1', isError: false, content: [{ type: 'text', text: 'x'.repeat(5000) }] };
  const enrichedEnd = enrichEvent(end, ws);
  assert.equal(typeof enrichedEnd.content, 'string');
  assert.ok(enrichedEnd.content.length < 5000, 'capped');
  assert.match(enrichedEnd.content, /more characters\)$/);
});

test('enrichEvent strips the absolute workspace root from tool detail (no path leak to the UI)', () => {
  // Windows-style root, backslash path in the result — the common real case.
  const win = 'C:\\Users\\me\\ws';
  const winEnd = enrichEvent(
    { kind: N.TOOL_END, toolUseId: 't', isError: false, content: `File created successfully at: ${win}\\outputs\\deck.pptx` },
    win,
  );
  assert.ok(!winEnd.content.includes(win), 'workspace root removed');
  assert.match(winEnd.content, /outputs\\deck\.pptx$/);

  // POSIX-style root, forward-slash path.
  const nix = '/home/me/ws';
  const nixEnd = enrichEvent(
    { kind: N.TOOL_END, toolUseId: 't', isError: false, content: `wrote ${nix}/summary.txt` },
    nix,
  );
  assert.equal(nixEnd.content, 'wrote summary.txt');
});

test('redactWorkspacePaths turns a bare root into a plain-language token and tolerates non-strings', () => {
  assert.equal(redactWorkspacePaths('saved under C:\\a\\ws', 'C:\\a\\ws'), 'saved under the workspace');
  assert.equal(redactWorkspacePaths(null, '/x'), null);
  assert.equal(redactWorkspacePaths('unchanged', null), 'unchanged');
});

test('unknown / malformed events are tolerated and emit nothing', () => {
  assert.deepEqual(normaliseEvent({ type: 'rate_limit_event' }), []);
  assert.deepEqual(normaliseEvent({ type: 'system', subtype: 'status' }), []);
  assert.deepEqual(normaliseEvent({ type: 'system', subtype: 'hook_started' }), []);
  assert.deepEqual(normaliseEvent(null), []);
  assert.deepEqual(normaliseEvent({}), []);
  assert.deepEqual(normaliseEvent({ type: 42 }), []);
});
