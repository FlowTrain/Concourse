// Unit tests for WorkspaceFs (§11) and the file REST endpoints. Path traversal
// is the one security control that matters in v0.1, so every path endpoint is
// exercised against escape attempts — this is the file to trust.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { WorkspaceFs, WorkspaceError, createHostState, createApp } from '../host.mjs';

const isWin = process.platform === 'win32';
const outsideAbs = isWin ? 'C:\\Windows\\win.ini' : '/etc/passwd';

let tmp;      // the workspace root
let server;   // live http server mounting createApp
let base;     // http://127.0.0.1:<port>

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-ws-')));
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hello workspace');
  fs.mkdirSync(path.join(tmp, 'outputs'));
  fs.writeFileSync(path.join(tmp, 'outputs', 'q3_board_deck.txt'), 'deck contents');

  const app = createApp(createHostState(tmp));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (p) => fetch(`${base}${p}`);

// --- WorkspaceFs containment (direct) ---------------------------------------

test('resolve() accepts in-workspace paths and rejects escapes with 403', () => {
  const wsfs = new WorkspaceFs(tmp);
  assert.ok(wsfs.resolve('notes.txt').endsWith('notes.txt'));
  assert.ok(wsfs.resolve('outputs').endsWith('outputs'));
  assert.equal(wsfs.resolve(''), tmp); // root itself

  for (const bad of ['../outside', '../../etc/passwd', outsideAbs, 'outputs/../../escape']) {
    try {
      wsfs.resolve(bad);
      assert.fail(`expected ${bad} to be rejected`);
    } catch (e) {
      assert.ok(e instanceof WorkspaceError);
      assert.equal(e.status, 403);
    }
  }
});

// --- Endpoints: happy path --------------------------------------------------

test('GET /api/files lists friendly entries', async () => {
  const res = await get('/api/files?path=');
  assert.equal(res.status, 200);
  const { entries } = await res.json();
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName['notes.txt'].kind, 'file');
  assert.equal(byName['notes.txt'].friendlyName, 'Notes');
  assert.equal(byName['outputs'].kind, 'directory');
  assert.equal(typeof byName['notes.txt'].size, 'number');
});

test('GET /api/files on a subfolder drops the known extension in friendlyName', async () => {
  const res = await get('/api/files?path=outputs');
  const { entries } = await res.json();
  // Find by name — directory iteration order is not guaranteed across platforms.
  const entry = entries.find((e) => e.name === 'q3_board_deck.txt');
  assert.ok(entry, 'entry present');
  assert.equal(entry.friendlyName, 'Q3 Board Deck');
});

test('entries are returned sorted by name', async () => {
  const res = await get('/api/files?path=');
  const { entries } = await res.json();
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, [...names].sort());
});

test('a symlink/junction that escapes the workspace is hidden from listings', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  const linkDir = path.join(tmp, 'escape-link');
  try {
    // Junction works on Windows without privilege; POSIX gets a dir symlink.
    try {
      fs.symlinkSync(outside, linkDir, 'junction');
    } catch {
      fs.symlinkSync(outside, linkDir);
    }
  } catch {
    fs.rmSync(outside, { recursive: true, force: true });
    t.skip('neither symlink nor junction creation permitted on this platform');
    return;
  }
  try {
    const res = await get('/api/files?path=');
    const { entries } = await res.json();
    assert.ok(!entries.some((e) => e.name === 'escape-link'), 'escaping link is not listed');
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('GET /api/file returns text; a folder is 400; a missing file is 404', async () => {
  const ok = await get('/api/file?path=notes.txt');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'hello workspace');

  assert.equal((await get('/api/file?path=outputs')).status, 400);
  assert.equal((await get('/api/file?path=nope.txt')).status, 404);
});

test('GET /api/download serves the file as an attachment', async () => {
  const res = await get('/api/download?path=notes.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment/);
  assert.match(res.headers.get('content-disposition') || '', /notes\.txt/);
  assert.equal(await res.text(), 'hello workspace');
});

// --- Endpoints: traversal is rejected (the security control) ----------------

test('every path endpoint rejects ../ traversal with 403', async () => {
  const attempts = [
    '/api/files?path=..',
    '/api/files?path=' + encodeURIComponent('../..'),
    '/api/file?path=' + encodeURIComponent('../../etc/passwd'),
    '/api/file?path=' + encodeURIComponent('outputs/../../escape'),
    '/api/download?path=' + encodeURIComponent('../../secret'),
  ];
  for (const a of attempts) {
    const res = await get(a);
    assert.equal(res.status, 403, `expected 403 for ${a}, got ${res.status}`);
  }
});

test('an absolute path outside the workspace is rejected with 403', async () => {
  const res = await get('/api/file?path=' + encodeURIComponent(outsideAbs));
  assert.equal(res.status, 403);
});

test('a symlink/junction that escapes the workspace is rejected with 403', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');

  // Prefer a file symlink; fall back to a directory junction (works on Windows
  // without elevated privilege) so the escape path is genuinely exercised.
  let query;
  let cleanup;
  try {
    const link = path.join(tmp, 'link.txt');
    fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    query = '/api/file?path=link.txt';
    cleanup = () => fs.rmSync(link, { force: true });
  } catch {
    try {
      const linkDir = path.join(tmp, 'linkdir');
      fs.symlinkSync(outside, linkDir, 'junction');
      query = '/api/files?path=linkdir';
      cleanup = () => fs.rmSync(linkDir, { recursive: true, force: true });
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      t.skip('neither symlink nor junction creation permitted on this platform');
      return;
    }
  }

  try {
    const res = await get(query);
    assert.equal(res.status, 403);
  } finally {
    cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
