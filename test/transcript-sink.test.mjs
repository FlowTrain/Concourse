// Unit tests for TranscriptSink (§10). The audit is append-only, wall-clock
// timestamped, keyed by session_id, and a failed write is a hard stop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptSink, N } from '../host.mjs';

const tmpWs = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-sink-')));
const readLines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

test('buffers pre-session events, then flushes them in event order once session_id is known', () => {
  const ws = tmpWs();
  try {
    const sink = new TranscriptSink(ws);
    sink.record({ kind: 'SUBMIT', at: 1, prompt: 'make me a brief' });
    assert.equal(sink.currentPath(), null, 'nothing written before session_id');

    sink.record({ kind: N.SESSION_OPEN, sessionId: 'sess-abc', model: 'm' });
    sink.record({ kind: N.TURN_END, ok: true });

    const file = sink.currentPath();
    assert.ok(file.endsWith(path.join('.concourse', 'transcripts', 'sess-abc.jsonl')));
    const lines = readLines(file);
    assert.deepEqual(lines.map((l) => l.kind), ['SUBMIT', 'SESSION_OPEN', 'TURN_END']);
    assert.equal(lines[0].prompt, 'make me a brief'); // the request is part of the record
    assert.ok(
      lines.every((l) => typeof l.ts === 'string' && !Number.isNaN(Date.parse(l.ts))),
      'every line carries a wall-clock timestamp',
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('append-only: later events accumulate in the same session file, never rewriting it', () => {
  const ws = tmpWs();
  try {
    const sink = new TranscriptSink(ws);
    sink.record({ kind: N.SESSION_OPEN, sessionId: 'sess-1' });
    sink.record({ kind: N.NARRATION, channel: 'speech', text: 'reading', partial: false });
    const file = sink.currentPath();
    const afterFirst = fs.readFileSync(file, 'utf8');

    // A later turn on the same session appends more; the prefix is untouched.
    sink.record({ kind: N.TOOL_START, tool: 'Read', toolUseId: 't1' });
    const afterSecond = fs.readFileSync(file, 'utf8');

    assert.ok(afterSecond.startsWith(afterFirst), 'file is appended to, never rewritten');
    assert.equal(readLines(file).length, 3);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a failed audit write throws and is not swallowed (hard stop)', () => {
  const ws = tmpWs();
  try {
    // Make .concourse a FILE so the transcripts directory can't be created.
    fs.writeFileSync(path.join(ws, '.concourse'), 'blocker');
    const sink = new TranscriptSink(ws);
    assert.throws(
      () => sink.record({ kind: N.SESSION_OPEN, sessionId: 'sess-x' }),
      'record() propagates the write failure',
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
