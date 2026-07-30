// Unit tests for the EventNormaliser (§5), driven from a recorded real session
// so the mapping is asserted against genuine CLI output, not invented shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseEvent, N } from '../host.mjs';

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

test('unknown / malformed events are tolerated and emit nothing', () => {
  assert.deepEqual(normaliseEvent({ type: 'rate_limit_event' }), []);
  assert.deepEqual(normaliseEvent({ type: 'system', subtype: 'status' }), []);
  assert.deepEqual(normaliseEvent({ type: 'system', subtype: 'hook_started' }), []);
  assert.deepEqual(normaliseEvent(null), []);
  assert.deepEqual(normaliseEvent({}), []);
  assert.deepEqual(normaliseEvent({ type: 42 }), []);
});
