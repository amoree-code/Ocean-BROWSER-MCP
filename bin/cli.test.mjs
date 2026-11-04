import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchPlan, UPSTREAM, FLAGS } from './cli.mjs';

test('launch plan pins upstream and keeps privacy flags', () => {
  const plan = launchPlan();
  assert.equal(plan.command, 'npx');
  assert.ok(plan.args.includes(UPSTREAM));
  assert.match(UPSTREAM, /@\d+\.\d+\.\d+$/);
  for (const flag of FLAGS) assert.ok(plan.args.includes(flag));
});

test('extra arguments are appended after the pinned flags', () => {
  assert.deepEqual(launchPlan(['--x']).args.at(-1), '--x');
});
