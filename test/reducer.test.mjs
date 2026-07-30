// Unit tests for the StateReducer (§6). Every transition, including the failure
// paths, plus a full drive of the recorded fixture end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normaliseEvent,
  reduceState,
  createInitialState,
  friendlyName,
  toolToState,
  N,
} from '../host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'session-readwrite.ndjson');

const submit = (at = 1000) => ({ kind: 'SUBMIT', at });

// --- §6.2 tool → state map --------------------------------------------------

test('§6.2 tool → state mapping', () => {
  for (const t of ['Read', 'Glob', 'Grep', 'NotebookRead']) assert.equal(toolToState(t), 'reading');
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(toolToState(t), 'writing');
  assert.equal(toolToState('Bash'), 'running');
  assert.equal(toolToState('mcp__atlassian__search'), 'thinking');
  assert.equal(toolToState('SomethingNew'), 'thinking');
});

// --- §6.3 friendly filenames ------------------------------------------------

test('§6.3 friendly filename: workspace-relative, extension dropped, title-cased', () => {
  const ws = path.resolve('/ws');
  const fn = friendlyName(path.join(ws, 'outputs', 'q3_board_deck.pptx'), ws);
  assert.equal(fn.friendly, 'Q3 Board Deck');
  assert.equal(fn.truePath, path.join(ws, 'outputs', 'q3_board_deck.pptx'));
});

test('§6.3 friendly filename: a path escaping the workspace falls back to the file name', () => {
  const ws = path.resolve('/ws');
  const fn = friendlyName(path.resolve('/etc/passwd'), ws);
  assert.equal(fn.friendly, 'Passwd');
});

// --- The core state transitions ---------------------------------------------

test('idle → thinking on submit', () => {
  const s0 = createInitialState('/ws');
  assert.equal(s0.state, 'idle');
  assert.equal(s0.activity, 'Ready');
  const s1 = reduceState(s0, submit());
  assert.equal(s1.state, 'thinking');
  assert.equal(s1.activity, 'Working out how to do this');
  assert.equal(s1.startedAt, 1000);
});

test('thinking → reading → thinking, recording the file read', () => {
  const ws = path.resolve('/ws');
  let s = reduceState(createInitialState(ws), submit());
  s = reduceState(s, { kind: N.TOOL_START, tool: 'Read', toolUseId: 't1', input: { file_path: path.join(ws, 'notes.txt') } });
  assert.equal(s.state, 'reading');
  assert.equal(s.activity, 'Reading Notes');
  assert.equal(s.friendlyName, 'Notes');
  s = reduceState(s, { kind: N.TOOL_END, toolUseId: 't1', isError: false });
  assert.equal(s.state, 'thinking');
  assert.equal(s.friendlyName, null);
  assert.deepEqual(s.filesTouched, [{ friendlyName: 'Notes', truePath: path.join(ws, 'notes.txt'), action: 'read' }]);
});

test('writing state uses "Editing <name>"; Glob has no file → "Looking through your files"', () => {
  const ws = path.resolve('/ws');
  let s = reduceState(createInitialState(ws), submit());
  s = reduceState(s, { kind: N.TOOL_START, tool: 'Write', toolUseId: 'w1', input: { file_path: path.join(ws, 'summary.txt') } });
  assert.equal(s.state, 'writing');
  assert.equal(s.activity, 'Editing Summary');

  let g = reduceState(createInitialState(ws), submit());
  g = reduceState(g, { kind: N.TOOL_START, tool: 'Glob', toolUseId: 'g1', input: { pattern: '**/*.md' } });
  assert.equal(g.state, 'reading');
  assert.equal(g.activity, 'Looking through your files');
  assert.equal(g.friendlyName, null);
});

test('Bash → running; MCP/other → thinking with a generic label', () => {
  const ws = path.resolve('/ws');
  let b = reduceState(createInitialState(ws), submit());
  b = reduceState(b, { kind: N.TOOL_START, tool: 'Bash', toolUseId: 'b1', input: { command: 'ls' } });
  assert.equal(b.state, 'running');
  assert.equal(b.activity, 'Running a command');

  let m = reduceState(createInitialState(ws), submit());
  m = reduceState(m, { kind: N.TOOL_START, tool: 'mcp__atlassian__search', toolUseId: 'm1', input: {} });
  assert.equal(m.state, 'thinking');
  assert.equal(m.activity, 'Working on it');
});

test('APPROVAL_NEEDED → awaiting_approval, carrying the request', () => {
  const s = reduceState(reduceState(createInitialState('/ws'), submit()), {
    kind: N.APPROVAL_NEEDED, requestId: 'r1', tool: 'Write', input: { file_path: 'x' },
  });
  assert.equal(s.state, 'awaiting_approval');
  assert.equal(s.activity, 'Needs your OK');
  assert.deepEqual(s.approval, { requestId: 'r1', tool: 'Write', input: { file_path: 'x' } });
});

test('TURN_END success → done with duration/cost; failure → blocked with a plain reason', () => {
  const base = reduceState(createInitialState('/ws'), submit());

  const done = reduceState(base, {
    kind: N.TURN_END, ok: true, subtype: 'success', durationMs: 1234, costUsd: 0.01, numTurns: 3, resultText: 'All done',
  });
  assert.equal(done.state, 'done');
  assert.equal(done.activity, 'Finished');
  assert.deepEqual(done.turn, { durationMs: 1234, costUsd: 0.01, numTurns: 3 });

  const blocked = reduceState(base, {
    kind: N.TURN_END, ok: false, isError: true, subtype: 'error_during_execution', resultText: 'stack trace here',
  });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.activity, "Stopped — here's what went wrong");
  assert.equal(blocked.reason, 'It ran into a problem while working and had to stop.');
  assert.equal(blocked.detail, 'stack trace here'); // raw text behind a disclosure, not in the headline
});

test('fatal HOST_ERROR → blocked; non-fatal HOST_ERROR never changes state', () => {
  const base = reduceState(createInitialState('/ws'), submit());

  const fatal = reduceState(base, { kind: N.HOST_ERROR, reason: 'spawn-failed', detail: 'ENOENT', fatal: true });
  assert.equal(fatal.state, 'blocked');
  assert.match(fatal.reason, /Couldn't start the assistant/);

  // A stderr warning arriving on an otherwise-fine turn must not block it.
  const reading = reduceState(base, { kind: N.TOOL_START, tool: 'Read', toolUseId: 't', input: { file_path: '/ws/a.txt' } });
  const warned = reduceState(reading, { kind: N.HOST_ERROR, reason: 'stderr', detail: 'a warning', fatal: false });
  assert.equal(warned.state, 'reading'); // unchanged
  assert.equal(warned.note, 'a warning');
});

test('a new submit from done/blocked resets to thinking with cleared traces', () => {
  const ws = path.resolve('/ws');
  let s = reduceState(createInitialState(ws), submit());
  s = reduceState(s, { kind: N.TOOL_START, tool: 'Read', toolUseId: 't', input: { file_path: path.join(ws, 'a.txt') } });
  s = reduceState(s, { kind: N.TOOL_END, toolUseId: 't', isError: false });
  s = reduceState(s, { kind: N.TURN_END, ok: true, subtype: 'success', durationMs: 1, costUsd: 0, numTurns: 1 });
  assert.equal(s.state, 'done');
  assert.equal(s.filesTouched.length, 1);

  const fresh = reduceState(s, submit(2000));
  assert.equal(fresh.state, 'thinking');
  assert.deepEqual(fresh.filesTouched, []);
  assert.equal(fresh.turn, null);
  assert.equal(fresh.startedAt, 2000);
});

// --- Full fixture drive: the real recorded turn end-to-end ------------------

test('fixture: the recorded read+write turn walks reading → writing → done', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const cwd = JSON.parse(raw.find((l) => l.includes('"init"'))).cwd; // workspace root for this recording

  let s = reduceState(createInitialState(cwd), submit());
  const statesSeen = [s.state];
  const readingNames = [];
  const writingNames = [];
  for (const line of raw) {
    for (const evt of normaliseEvent(JSON.parse(line))) {
      s = reduceState(s, evt);
      statesSeen.push(s.state);
      if (s.state === 'reading' && s.friendlyName) readingNames.push(s.friendlyName);
      if (s.state === 'writing' && s.friendlyName) writingNames.push(s.friendlyName);
    }
  }

  assert.ok(statesSeen.includes('reading'), 'passed through reading');
  assert.ok(statesSeen.includes('writing'), 'passed through writing');
  assert.equal(s.state, 'done', 'ended in done');
  assert.ok(readingNames.includes('Notes'), `read Notes (saw ${readingNames})`);
  assert.ok(writingNames.includes('Summary'), `wrote Summary (saw ${writingNames})`);

  // reading precedes writing (dispatch order preserved through the whole chain)
  assert.ok(statesSeen.indexOf('reading') < statesSeen.indexOf('writing'));

  // done carries what the UI shows: duration, and both files touched.
  assert.equal(typeof s.turn.durationMs, 'number');
  const touched = s.filesTouched.map((f) => `${f.friendlyName}:${f.action}`).sort();
  assert.deepEqual(touched, ['Notes:read', 'Summary:edited']);
});
