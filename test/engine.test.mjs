// Guards on the exact CLI invocation CliEngine builds. No shell may run and the
// dangerous skip must never appear (Rule 5 / §4.1 / soul.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliEngine } from '../host.mjs';

/** Read the value that follows `flag` in an args array. */
function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('buildArgs denies every shell tool and never grants one', () => {
  const args = new CliEngine().buildArgs({ prompt: 'do a thing', sessionId: null });

  // Both shell tools are explicitly denied (bare name removes the tool per docs).
  const denied = valueAfter(args, '--disallowedTools');
  assert.ok(denied !== undefined, '--disallowedTools flag is present');
  const deniedSet = new Set(denied.split(','));
  assert.ok(deniedSet.has('Bash'), 'Bash denied');
  assert.ok(deniedSet.has('PowerShell'), 'PowerShell denied');

  // …and no shell ever appears in the allowlist.
  const allowed = valueAfter(args, '--allowedTools');
  assert.ok(allowed !== undefined, '--allowedTools flag is present');
  const allowedSet = new Set(allowed.split(','));
  assert.ok(!allowedSet.has('Bash') && !allowedSet.has('PowerShell'), 'no shell in the allowlist');
});

test('buildArgs never contains a permission bypass', () => {
  const args = new CliEngine().buildArgs({ prompt: 'x', sessionId: null });
  const joined = args.join(' ');
  assert.ok(!joined.includes('--dangerously-skip-permissions'));
  assert.ok(!joined.includes('bypassPermissions'));
  assert.equal(valueAfter(args, '--permission-mode'), 'acceptEdits');
});

test('buildArgs adds --resume only when resuming', () => {
  const first = new CliEngine().buildArgs({ prompt: 'x', sessionId: null });
  assert.ok(!first.includes('--resume'));

  const resumed = new CliEngine().buildArgs({ prompt: 'x', sessionId: 'sess-123' });
  assert.equal(valueAfter(resumed, '--resume'), 'sess-123');
});
