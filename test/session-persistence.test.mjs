// Unit tests for session persistence (§7): session.json is written after a turn
// and read back on the next start to offer "continue where you left off".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistSession, loadPriorSession, createHostState } from '../host.mjs';

const tmpWs = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-sess-')));

test('persistSession writes session.json and loadPriorSession reads it back', () => {
  const ws = tmpWs();
  try {
    const hostState = createHostState(ws);
    hostState.sessionId = 'sess-42';
    hostState.turnCount = 3;
    hostState.turnState.startedAt = 1720000000000;

    persistSession(hostState);

    const prior = loadPriorSession(ws);
    assert.deepEqual(prior, {
      sessionId: 'sess-42',
      startedAt: 1720000000000,
      workspaceRoot: ws,
      turnCount: 3,
    });
    // It really is on disk under .concourse/.
    assert.ok(fs.existsSync(path.join(ws, '.concourse', 'session.json')));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('persistSession is a no-op before a session_id exists', () => {
  const ws = tmpWs();
  try {
    const hostState = createHostState(ws); // sessionId is null
    persistSession(hostState);
    assert.equal(loadPriorSession(ws), null);
    assert.ok(!fs.existsSync(path.join(ws, '.concourse', 'session.json')));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('loadPriorSession returns null when there is no file or no usable session_id', () => {
  const ws = tmpWs();
  try {
    assert.equal(loadPriorSession(ws), null, 'no file');

    fs.mkdirSync(path.join(ws, '.concourse'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.concourse', 'session.json'), JSON.stringify({ turnCount: 1 }));
    assert.equal(loadPriorSession(ws), null, 'file without a session_id');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
