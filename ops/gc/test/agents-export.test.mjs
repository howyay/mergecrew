// Tests for the MergeCrew RunnerProfile -> Gas City agent exporter.
//
//   node --test ops/gc/test/agents-export.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentName,
  exportAgent,
  renderAgentToml,
  runnerProfileToAgent,
  runtimeForKind,
} from '../agents-export.mjs';

test('runtimeForKind maps the placement kinds', () => {
  assert.equal(runtimeForKind('none'), 'local');
  assert.equal(runtimeForKind('fargate_byo'), 'k8s');
  assert.equal(runtimeForKind(undefined), 'local');
  assert.throws(() => runtimeForKind('moon-base'), /unknown runner kind/);
});

test('agentName qualifies with the rig', () => {
  assert.equal(agentName('mergecrew', 'dev-1'), 'mergecrew/dev-1');
  assert.equal(agentName('', 'dev-1'), 'dev-1');
  assert.throws(() => agentName('mergecrew'), /name is required/);
});

test('a local profile maps to a local runtime with a one-session pool', () => {
  const agent = runnerProfileToAgent({ kind: 'none' }, { name: 'dev-1', rig: 'mergecrew' });
  assert.equal(agent.name, 'mergecrew/dev-1');
  assert.equal(agent.runtime, 'local');
  assert.equal(agent.min_active_sessions, 0);
  assert.equal(agent.max_active_sessions, 1);
  assert.equal(agent.wake_mode, 'fresh');
  assert.ok(agent.skills.includes('core.gc-work'));
});

test('a bring-your-own-cloud profile maps to k8s and states the difference', () => {
  const agent = runnerProfileToAgent(
    { kind: 'fargate_byo', awsRoleArn: 'arn:aws:iam::1:role/r', awsExternalId: 'ext-1', awsRegion: 'us-west-2' },
    { name: 'dev-2', rig: 'mergecrew' },
  );
  assert.equal(agent.runtime, 'k8s');
  assert.match(agent.notes.join(' '), /customer AWS account/);
  assert.match(agent.notes.join(' '), /Unmapped field awsRoleArn/);
  assert.match(agent.notes.join(' '), /Unmapped field awsExternalId/);
});

test('the token hash is reported as unmapped, not reused', () => {
  const agent = runnerProfileToAgent({ kind: 'none', tokenHash: 'deadbeef' }, { name: 'dev-3' });
  assert.match(agent.notes.join(' '), /session identity/);
  assert.doesNotMatch(JSON.stringify(agent), /deadbeef/);
});

test('the pool size is checked', () => {
  assert.throws(
    () => runnerProfileToAgent({ kind: 'none', minActiveSessions: 3, maxActiveSessions: 1 }, { name: 'x' }),
    /below min/,
  );
  const agent = runnerProfileToAgent({ kind: 'none', minActiveSessions: 1, maxActiveSessions: 4 }, { name: 'x' });
  assert.equal(agent.min_active_sessions, 1);
  assert.equal(agent.max_active_sessions, 4);
});

test('the rendered TOML carries every field gc reads', () => {
  const toml = exportAgent({ kind: 'none' }, { name: 'dev-1', rig: 'mergecrew' }).toml;
  for (const key of ['name', 'scope', 'runtime', 'wake_mode', 'work_dir', 'harness', 'model', 'idle_timeout', 'min_active_sessions', 'max_active_sessions', 'nudge', 'skills']) {
    assert.match(toml, new RegExp(`^${key} = `, 'm'), `missing key: ${key}`);
  }
  assert.match(toml, /^name = "mergecrew\/dev-1"$/m);
  assert.match(toml, /^runtime = "local"$/m);
  assert.match(toml, /^min_active_sessions = 0$/m);
});

test('the exporter refuses an unnamed profile', () => {
  assert.throws(() => runnerProfileToAgent({}, {}), /name is required/);
});

test('a profile with a null field does not create a note', () => {
  const agent = runnerProfileToAgent({ kind: 'none', awsRoleArn: null, tokenHash: '' }, { name: 'dev-4' });
  assert.deepEqual(agent.notes, []);
});

test('renderAgentToml escapes a hostile nudge', () => {
  const agent = runnerProfileToAgent({ kind: 'none' }, { name: 'dev-5' });
  agent.nudge = 'say "hi" \\ now';
  const toml = renderAgentToml(agent);
  assert.match(toml, /^nudge = "say \\"hi\\" \\\\ now"$/m);
});
