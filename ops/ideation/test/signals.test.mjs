import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractActionableMarker, extractComments, findMarkers, collectSignals } from '../lib/signals.mjs';
import { MIN_CHURN_SAMPLE } from '../lib/generator.mjs';

test('extractActionableMarker accepts canonical comment markers', () => {
  const cases = [
    ['// TODO: validate input', 'TODO', 'validate input'],
    ['# TODO: handle 404', 'TODO', 'handle 404'],
    ['/* HACK: retried once */', 'HACK', 'retried once */'],
    ['   * FIXME: this is wrong', 'FIXME', 'this is wrong'],
    ['<!-- TODO: document this -->', 'TODO', 'document this -->'],
    ['// TODO(alice): add timeout', 'TODO', 'add timeout'],
    ['; TODO: clojure style', 'TODO', 'clojure style'],
    ['- TODO: gfm bullet', 'TODO', 'gfm bullet'],
  ];
  for (const [line, marker, text] of cases) {
    const got = extractActionableMarker(line);
    assert.ok(got, `expected a marker in: ${line}`);
    assert.equal(got.marker, marker, line);
    assert.equal(got.text, text, line);
  }
  assert.equal(extractActionableMarker('// TODO(alice): x').owner, 'alice');
  assert.equal(extractActionableMarker('// TODO: x').owner, null);
});

test('extractActionableMarker ignores prose, patterns and marker-less lines', () => {
  const rejected = [
    // prose about markers, not a marker
    ' * TODO/FIXME density,',
    ' * You receive a JSON signal bundle (git history, TODO clusters, open backlog items, last CI result).',
    ' *   1. be written in the canonical colon form: `TODO:`, `FIXME(owner):`;',
    // marker without the colon form
    '// TODO fix this eventually',
    '// TODO',
    // pattern text glued to regex punctuation
    String.raw`  const m = /\b(TODO|FIXME|HACK)\b[:\s]*(.{0,120})/.exec(lines[i]);`,
    '// see TODO/FIXME for details',
    // a string literal, not a comment
    'const label = "TODO: later";',
    'unrelated line without markers',
  ];
  for (const line of rejected) {
    assert.equal(extractActionableMarker(line), null, `should not count: ${line}`);
  }
});

test('extractComments skips string literals but keeps comments', () => {
  const source = [
    'const a = "// TODO: in a string";',
    "const b = '/* FIXME: also a string */';",
    'const c = `# HACK: template literal`;',
    '// TODO: real comment',
    '/* FIXME(bob): block comment',
    ' * and a continued line',
    ' */',
    'const d = 1; // TODO: trailing comment',
  ].join('\n');

  const comments = extractComments(source, '.ts').map((c) => c.text);
  assert.equal(comments.length, 3, JSON.stringify(comments));
  assert.ok(comments[0].includes('TODO: real comment'));
  assert.ok(comments[1].includes('FIXME(bob): block comment'));
  assert.ok(comments[2].includes('TODO: trailing comment'));

  const markers = findMarkers(source, '.ts');
  assert.deepEqual(
    markers.map((m) => [m.line, m.marker]),
    [
      [4, 'TODO'],
      [5, 'FIXME'],
      [8, 'TODO'],
    ],
  );
});

test('extractComments honours hash comments only for hash-comment languages', () => {
  const py = extractComments('# TODO: python comment\nx = 1\n', '.py').map((c) => c.text);
  assert.deepEqual(py, [' TODO: python comment']);
  const ts = extractComments('const x = 1; # not a comment in ts\n', '.ts');
  assert.equal(ts.length, 0, JSON.stringify(ts));
  const md = extractComments('<!-- TODO: docs note -->\n', '.md').map((c) => c.text);
  assert.deepEqual(md, [' TODO: docs note ']);
});

test('collectSignals counts only actionable markers in a real tree', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'signals-todo-'));
  try {
    await mkdir(path.join(repo, 'src', 'deep'), { recursive: true });
    await writeFile(
      path.join(repo, 'src', 'a.ts'),
      [
        '// TODO: real one',
        '// FIXME(bob): real two',
        'const x = "TODO: not a comment";',
        '// prose mentioning TODO lists is not a task',
        '// TODO missing colon is skipped',
      ].join('\n'),
    );
    // 2 markers in one directory, plus the threshold case exercised via src
    await writeFile(
      path.join(repo, 'src', 'deep', 'b.ts'),
      ['// TODO: only two here', '// HACK: and another'].join('\n'),
    );

    const signals = await collectSignals(repo);
    assert.equal(signals.todos.total, 4, JSON.stringify(signals.todos.clusters));
    const byDir = new Map(signals.todos.clusters.map((c) => [c.dir, c.count]));
    assert.equal(byDir.get('src'), 2);
    assert.equal(byDir.get('src/deep'), 2);
    const sample = signals.todos.clusters.find((c) => c.dir === 'src').samples[0];
    assert.match(sample, /^src\/a\.ts:1 real one$/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('fix-churn needs a real sample, not a one-commit shallow clone', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'signals-churn-'));
  try {
    await writeFile(path.join(repo, 'README.md'), '# x\n');
    const { execFile } = await import('node:child_process');
    const git = (...args) =>
      new Promise((resolve, reject) =>
        execFile(
          'git',
          // This machine signs commits by default and the sandbox holds no key,
          // so signing is disabled for the fixture repo only.
          ['-c', 'commit.gpgsign=false', '-C', repo, ...args],
          {
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 'fixture',
              GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
              GIT_COMMITTER_NAME: 'fixture',
              GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
            },
          },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        ),
      );
    await git('init', '-q');
    await writeFile(path.join(repo, 'README.md'), '# x\n1\n');
    await git('add', '-A');
    await git('commit', '-qm', 'fix: only commit');
    assert.equal((await git('rev-list', '--count', 'HEAD')).trim(), '1', 'fixture repo must really contain one commit');

    const signals = await collectSignals(repo);
    // the shallow-single-commit shape: ratio is 1.0 but the sample is too small
    assert.equal(signals.commitCount, 1);
    assert.equal(signals.fixishRatio, 1);
    assert.ok(signals.commitCount < MIN_CHURN_SAMPLE);

    const { heuristicIdeas } = await import('../lib/generator.mjs');
    const ideas = heuristicIdeas(signals);
    assert.equal(ideas.filter((i) => i.source === 'fix-churn').length, 0, 'churn idea must not fire on a 1-commit sample');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
