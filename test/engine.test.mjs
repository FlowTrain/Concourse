// Guards on the exact CLI invocation CliEngine builds. Bash must be denied and
// the dangerous skip must never appear (Rule 5 / §4.1 / soul.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliEngine } from '../host.mjs';

/** Read the value that follows `flag` in an args array. */
function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('buildArgs denies Bash and never grants it', () => {
  const args = new CliEngine().buildArgs({ prompt: 'do a thing', sessionId: null });

  // Bash is explicitly denied…
  assert.equal(valueAfter(args, '--disallowedTools'), 'Bash');
  // …and never appears in the allowlist.
  assert.ok(!valueAfter(args, '--allowedTools').split(',').includes('Bash'));
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
