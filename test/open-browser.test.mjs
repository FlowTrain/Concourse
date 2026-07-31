// Unit tests for the auto-open-browser helper (§13 criterion 1: `npm start`
// launches the host AND opens the browser). The opener is fire-and-forget, so
// we inject a fake spawn and assert the command it would run per platform, plus
// the CONCOURSE_NO_OPEN escape hatch that keeps headless runs / tests quiet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserOpenCommand, openBrowser } from '../host.mjs';

test('§13-1 opener command is correct per platform', () => {
  const url = 'http://127.0.0.1:7317';
  assert.deepEqual(browserOpenCommand(url, 'win32'), { command: 'cmd', args: ['/c', 'start', '', url] });
  assert.deepEqual(browserOpenCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserOpenCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
});

test('§13-1 openBrowser launches the opener with the resolved command', () => {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    return { on() {}, unref() {} };
  };
  const launched = openBrowser('http://127.0.0.1:7317', { env: {}, spawnFn, platform: 'win32' });
  assert.equal(launched, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:7317'] });
});

test('§13-1 CONCOURSE_NO_OPEN suppresses the opener (headless / tests)', () => {
  let called = false;
  const spawnFn = () => { called = true; return { on() {}, unref() {} }; };
  const launched = openBrowser('http://127.0.0.1:7317', { env: { CONCOURSE_NO_OPEN: '1' }, spawnFn, platform: 'win32' });
  assert.equal(launched, false);
  assert.equal(called, false, 'no opener is spawned when suppressed');
});

test('§13-1 a failing opener never throws (startup must not depend on it)', () => {
  const spawnFn = () => { throw new Error('no shell'); };
  let launched;
  assert.doesNotThrow(() => {
    launched = openBrowser('http://127.0.0.1:7317', { env: {}, spawnFn, platform: 'linux' });
  });
  assert.equal(launched, false);
});
