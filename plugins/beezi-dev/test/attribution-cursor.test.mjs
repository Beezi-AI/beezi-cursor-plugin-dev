import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAttributionRuns } from '../lib/attribution-cursor.mjs';

// ── Fixture helpers ────────────────────────────────────────────────────────────────────────────
//
// `indexedEvents` is the contract shape: `{ index, event }` with an ABSOLUTE raw sidecar index,
// exactly what delta-cursor's `from`/`to` bounds count. Building them through a helper keeps every
// fixture honest about that (a test that relied on array position would pass for the wrong reason).
// Real epoch-millisecond stamps. The writer stamps Date.now(), and lib/subagents-cursor.mjs's
// timestampOf reads anything below ~1e12 as epoch SECONDS — so a fixture using small integers
// would silently be multiplied by 1000 and stop testing what it says it tests.
const T0 = 1700000000000;

function indexed(events, baseLine = 0) {
  return events.map((event, i) => ({ index: baseLine + i, event }));
}

// A repoRootOf that maps any directory to the longest configured root containing it.
function rootsOf(roots) {
  return (dir) => {
    if (typeof dir !== 'string' || dir === '') return null;
    let best = null;
    for (const root of roots) {
      if ((dir === root || dir.startsWith(root + '/')) && (best === null || root.length > best.length)) {
        best = root;
      }
    }
    return best;
  };
}

// Every run's attribution, as compact tuples — easier to read in an assertion than four-key objects.
function shape(runs) {
  return runs.map((r) => [r.from, r.to, r.repoRoot, r.branch]);
}

function assertCovers(runs, from, to) {
  if (to <= from) {
    assert.deepEqual(runs, [], 'an empty window produces no runs');
    return;
  }
  assert.ok(runs.length > 0, 'a nonempty window produces at least one run');
  assert.equal(runs[0].from, from, 'runs[0].from === from');
  assert.equal(runs[runs.length - 1].to, to, 'last run .to === to');
  for (let i = 0; i < runs.length; i += 1) {
    assert.ok(runs[i].to > runs[i].from, `run ${i} is nonempty`);
    if (i > 0) assert.equal(runs[i - 1].to, runs[i].from, `run ${i} is contiguous with its predecessor`);
  }
}

const ALWAYS_MAIN = () => 'main';

// ── 1. Multi-root workspace: the FIRST event names the repo, not workspace_roots[0] ────────────

test('the first event\'s own path wins over the stamped workspace root', () => {
  const repoRootOf = rootsOf(['/ws/alpha', '/ws/beta']);
  const events = [
    { ev: 'edit', path: '/ws/beta/src/a.ts', cwd: '/ws/alpha', ts: T0 + 1000 },
    { ev: 'gen', model: 'x', cwd: '/ws/alpha', ts: T0 + 1100 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 2, cwd: '/ws/alpha', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assertCovers(runs, 0, 2);
  assert.deepEqual(shape(runs), [[0, 2, '/ws/beta', 'main']]);
});

// ── 2. A → B → A ───────────────────────────────────────────────────────────────────────────────

test('repo A → B → A produces three contiguous runs split at the switching events', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  const events = [
    { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 },
    { ev: 'edit', path: '/ws/b/y.ts', cwd: '/ws/a', ts: T0 + 2000 },
    { ev: 'edit', path: '/ws/a/z.ts', cwd: '/ws/a', ts: T0 + 3000 },
  ];
  const { runs, nextAttribution } = planAttributionRuns(indexed(events), {
    from: 0, to: 3, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assertCovers(runs, 0, 3);
  assert.deepEqual(shape(runs), [
    [0, 1, '/ws/a', 'main'],
    [1, 2, '/ws/b', 'main'],
    [2, 3, '/ws/a', 'main'],
  ]);
  assert.deepEqual(nextAttribution, { repoRoot: '/ws/a', branch: 'main' });
});

// ── 3. Shell directory change ──────────────────────────────────────────────────────────────────

test('a recognized cd in a shell event moves attribution; the command is never executed', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/other']);
  const events = [
    { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 },
    { ev: 'shell', cmd: 'cd ../other && npm test', cwd: '/ws/a', ts: T0 + 2000 },
    { ev: 'gen', model: 'x', cwd: '/ws/a', ts: T0 + 2100 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 3, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assertCovers(runs, 0, 3);
  assert.deepEqual(shape(runs), [
    [0, 1, '/ws/a', 'main'],
    [1, 3, '/ws/other', 'main'],
  ]);
});

test('a shell command with no recognized directory syntax carries the previous repo forward', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const events = [
    { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 },
    // `git -C` is real directory syntax to git, but it is NOT the cd/pushd grammar this module
    // recognizes — an unrecognized command must never be interpreted, only carried through.
    { ev: 'shell', cmd: 'git -C /ws/elsewhere status', cwd: '/ws/a', ts: T0 + 2000 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 2, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [[0, 2, '/ws/a', 'main']]);
});

// ── 4. Relative and Windows paths resolve against the stamped cwd ──────────────────────────────

test('a relative edit path resolves against the event\'s own stamped cwd', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  const events = [
    { ev: 'edit', path: 'src/a.ts', cwd: '/ws/a', ts: T0 + 1000 },
    { ev: 'edit', path: 'lib/b.ts', cwd: '/ws/b', ts: T0 + 2000 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 2, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [
    [0, 1, '/ws/a', 'main'],
    [1, 2, '/ws/b', 'main'],
  ]);
});

test('Windows backslash paths and drive roots normalize to one representation', () => {
  const repoRootOf = rootsOf(['C:/ws/a', 'C:/ws/b']);
  const events = [
    { ev: 'edit', path: 'C:\\ws\\a\\src\\x.ts', cwd: 'C:\\ws\\a', ts: T0 + 1000 },
    { ev: 'edit', path: 'src\\y.ts', cwd: 'C:\\ws\\b', ts: T0 + 2000 },
    { ev: 'shell', cmd: 'cd /d C:\\ws\\a', cwd: 'C:\\ws\\b', ts: T0 + 3000 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 3, cwd: 'C:\\ws\\a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [
    [0, 1, 'C:/ws/a', 'main'],
    [1, 2, 'C:/ws/b', 'main'],
    [2, 3, 'C:/ws/a', 'main'],
  ]);
});

// ── 5. No signal at all ────────────────────────────────────────────────────────────────────────

test('a window with no path signal falls back to the session cwd, as one run', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const events = [
    { ev: 'gen', model: 'x', ts: T0 + 1000 },
    { ev: 'tool', tool: 'read_file', ts: T0 + 1100 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 2, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [[0, 2, '/ws/a', 'main']]);
});

test('no signal and no resolvable cwd still covers the window, with a null repo', () => {
  const { runs } = planAttributionRuns(indexed([{ ev: 'gen', ts: T0 + 1000 }]), {
    from: 0, to: 1, cwd: null, repoRootOf: () => null, branchAt: () => null,
  });
  assert.deepEqual(shape(runs), [[0, 1, null, '(unknown)']]);
});

test('an event stamped with a cwd seeds the repo when the session cwd is unknown', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const { runs } = planAttributionRuns(indexed([{ ev: 'gen', cwd: '/ws/a/sub', ts: T0 + 1000 }]), {
    from: 0, to: 1, cwd: null, repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [[0, 1, '/ws/a', 'main']]);
});

// ── 6. Missing timestamps ──────────────────────────────────────────────────────────────────────

test('events with no timestamp carry the branch forward instead of splitting', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const branchAt = (root, ms) => {
    assert.ok(ms != null, 'branchAt is not asked about an event with no timestamp');
    return ms >= T0 + 2000 ? 'feature' : 'main';
  };
  const events = [
    { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 },
    { ev: 'gen', model: 'x', cwd: '/ws/a' },            // no ts at all
    { ev: 'gen', model: 'x', cwd: '/ws/a', ts: 'not-a-date' },
    { ev: 'edit', path: '/ws/a/y.ts', cwd: '/ws/a', ts: T0 + 2000 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 4, cwd: '/ws/a', repoRootOf, branchAt,
  });
  assertCovers(runs, 0, 4);
  assert.deepEqual(shape(runs), [
    [0, 3, '/ws/a', 'main'],
    [3, 4, '/ws/a', 'feature'],
  ]);
});

test('a first event with no timestamp still resolves a branch (root-only lookup)', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const seen = [];
  const branchAt = (root, ms) => { seen.push([root, ms]); return 'head-branch'; };
  const { runs } = planAttributionRuns(indexed([{ ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a' }]), {
    from: 0, to: 1, cwd: '/ws/a', repoRootOf, branchAt,
  });
  assert.deepEqual(shape(runs), [[0, 1, '/ws/a', 'head-branch']]);
  assert.deepEqual(seen, [['/ws/a', null]], 'a null ms asks the resolver for HEAD, it is not skipped');
});

// ── 7. git throws ──────────────────────────────────────────────────────────────────────────────

test('a repoRootOf that throws costs the attribution, never the window', () => {
  const events = [
    { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 },
    { ev: 'gen', model: 'x', cwd: '/ws/a', ts: T0 + 2000 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0,
    to: 2,
    cwd: '/ws/a',
    repoRootOf: () => { throw new Error('fatal: detected dubious ownership'); },
    // The real resolver (checkpoint's branchOf) answers '(unknown)' for a null root; the planner
    // delegates that policy rather than second-guessing it, so the fake mirrors it exactly.
    branchAt: (root) => (root ? 'main' : '(unknown)'),
  });
  assertCovers(runs, 0, 2);
  assert.deepEqual(shape(runs), [[0, 2, null, '(unknown)']]);
});

test('a branchAt that throws yields (unknown) without losing the repo', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const { runs } = planAttributionRuns(indexed([{ ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1 }]), {
    from: 0,
    to: 1,
    cwd: '/ws/a',
    repoRootOf,
    branchAt: () => { throw new Error('no reflog'); },
  });
  assert.deepEqual(shape(runs), [[0, 1, '/ws/a', '(unknown)']]);
});

test('a null/empty branch answer becomes the (unknown) fallback', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const { runs } = planAttributionRuns(indexed([{ ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1 }]), {
    from: 0, to: 1, cwd: '/ws/a', repoRootOf, branchAt: () => '',
  });
  assert.deepEqual(shape(runs), [[0, 1, '/ws/a', '(unknown)']]);
});

// ── 8. Branch change at the exact reflog timestamp ─────────────────────────────────────────────

test('an event exactly at a checkout boundary bills the NEW branch', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  // Mirrors lib/reflog.mjs branchAt: the last boundary whose ms <= target wins, so `ms === 2000`
  // resolves to the branch checked out AT 2000.
  const branchAt = (root, ms) => (ms != null && ms >= T0 + 2000 ? 'feature' : 'main');
  const events = [
    { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1999 },
    { ev: 'edit', path: '/ws/a/y.ts', cwd: '/ws/a', ts: T0 + 2000 },
    { ev: 'edit', path: '/ws/a/z.ts', cwd: '/ws/a', ts: T0 + 2001 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 3, cwd: '/ws/a', repoRootOf, branchAt,
  });
  assertCovers(runs, 0, 3);
  assert.deepEqual(shape(runs), [
    [0, 1, '/ws/a', 'main'],
    [1, 3, '/ws/a', 'feature'],
  ]);
});

// ── 9. Carry-forward and the fallback-not-a-switch-back rule ───────────────────────────────────

test('a repeated workspace-root cwd stamp is fallback context, not a switch back', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  const events = [
    { ev: 'edit', path: '/ws/b/x.ts', cwd: '/ws/a', ts: T0 + 1000 },
    { ev: 'gen', model: 'x', cwd: '/ws/a', ts: T0 + 1100 },
    { ev: 'tool', tool: 'read_file', cwd: '/ws/a', ts: T0 + 1200 },
    { ev: 'shell', cmd: 'npm test', cwd: '/ws/a', ts: T0 + 1300 },
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 4, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [[0, 4, '/ws/b', 'main']],
    'once /ws/b is established, three events stamped with the workspace root do not pull it back');
});

test('an unresolvable edit path carries the established repo forward rather than nulling it', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const events = [
    { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 },
    { ev: 'edit', path: '/tmp/scratch/notes.md', cwd: '/ws/a', ts: T0 + 2000 }, // outside any repo
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 2, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [[0, 2, '/ws/a', 'main']]);
});

test('`previous` seeds the first run so a window of non-path events keeps its repo', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  const { runs, nextAttribution } = planAttributionRuns(
    indexed([{ ev: 'gen', model: 'x', cwd: '/ws/a', ts: T0 + 5000 }], 7),
    {
      from: 7,
      to: 8,
      cwd: '/ws/a',
      repoRootOf,
      branchAt: ALWAYS_MAIN,
      previous: { repoRoot: '/ws/b', branch: 'main' },
    },
  );
  assert.deepEqual(shape(runs), [[7, 8, '/ws/b', 'main']]);
  assert.deepEqual(nextAttribution, { repoRoot: '/ws/b', branch: 'main' });
});

// ── 10. Window bounds, invariants and determinism ──────────────────────────────────────────────

test('events outside [from, to) never establish context or move a boundary', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  const events = [
    { ev: 'edit', path: '/ws/b/before.ts', cwd: '/ws/a', ts: T0 + 500 },  // index 0, before the window
    { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 },      // index 1
    { ev: 'edit', path: '/ws/b/after.ts', cwd: '/ws/a', ts: T0 + 3000 },  // index 2, after the window
  ];
  const { runs } = planAttributionRuns(indexed(events), {
    from: 1, to: 2, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assertCovers(runs, 1, 2);
  assert.deepEqual(shape(runs), [[1, 2, '/ws/a', 'main']]);
});

test('a full read and a byte-resume read produce identical boundaries', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  const all = [
    { ev: 'edit', path: '/ws/a/0.ts', cwd: '/ws/a', ts: T0 + 1000 },
    { ev: 'edit', path: '/ws/a/1.ts', cwd: '/ws/a', ts: T0 + 1100 },
    { ev: 'edit', path: '/ws/b/2.ts', cwd: '/ws/a', ts: T0 + 1200 },
    { ev: 'gen', model: 'x', cwd: '/ws/a', ts: T0 + 1300 },
    { ev: 'edit', path: '/ws/a/4.ts', cwd: '/ws/a', ts: T0 + 1400 },
  ];
  const options = { from: 2, to: 5, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN };

  const full = planAttributionRuns(indexed(all), options);              // whole file, baseLine 0
  const resumed = planAttributionRuns(indexed(all.slice(2), 2), options); // resumed at byte/line 2

  assert.deepEqual(shape(full.runs), shape(resumed.runs));
  assert.deepEqual(full.nextAttribution, resumed.nextAttribution);
  assert.deepEqual(shape(full.runs), [
    [2, 4, '/ws/b', 'main'],
    [4, 5, '/ws/a', 'main'],
  ]);
});

test('an empty window produces no runs and preserves the previous attribution', () => {
  const previous = { repoRoot: '/ws/a', branch: 'main' };
  const { runs, nextAttribution } = planAttributionRuns([], {
    from: 4, to: 4, cwd: '/ws/a', repoRootOf: rootsOf(['/ws/a']), branchAt: ALWAYS_MAIN, previous,
  });
  assert.deepEqual(runs, []);
  assert.deepEqual(nextAttribution, previous);
  assert.notEqual(nextAttribution, previous, 'the caller\'s object is copied, never aliased');
});

test('a window whose events were all dropped by the reader still covers its range', () => {
  // `to` counts raw lines; a reader that hands back fewer parsed events must not shrink the window.
  const { runs } = planAttributionRuns([], {
    from: 0, to: 3, cwd: '/ws/a', repoRootOf: rootsOf(['/ws/a']), branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [[0, 3, '/ws/a', 'main']]);
});

test('runs are frozen and the invariants hold over a churning fixture', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b', '/ws/c']);
  const roots = ['/ws/a', '/ws/b', '/ws/c'];
  const events = [];
  for (let i = 0; i < 30; i += 1) {
    events.push({ ev: 'edit', path: `${roots[i % 3]}/f${i}.ts`, cwd: '/ws/a', ts: T0 + 1000 + i * 10 });
  }
  const { runs } = planAttributionRuns(indexed(events), {
    from: 0, to: 30, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assertCovers(runs, 0, 30);
  assert.equal(runs.length, 30);
  assert.ok(Object.isFrozen(runs[0]), 'each run is frozen');
  assert.ok(Object.isFrozen(runs), 'the run list is frozen');
});

test('malformed indexedEvents entries are skipped, not thrown on', () => {
  const repoRootOf = rootsOf(['/ws/a']);
  const input = [
    null,
    { index: 0, event: { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 } },
    { index: 1 },                       // no event
    { index: 'two', event: { ev: 'gen' } }, // non-numeric index
    'junk',
  ];
  const { runs } = planAttributionRuns(input, {
    from: 0, to: 2, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [[0, 2, '/ws/a', 'main']]);
});

test('two entries on one raw index never open a zero-width run', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  // One raw sidecar line indexed twice. Closing the open run at its own start would leave
  // `{from: 0, to: 0}` behind and break the `to > from` invariant for every consumer.
  const input = [
    { index: 0, event: { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 } },
    { index: 0, event: { ev: 'edit', path: '/ws/b/y.ts', cwd: '/ws/a', ts: T0 + 1000 } },
    { index: 1, event: { ev: 'gen', model: 'x', cwd: '/ws/a', ts: T0 + 1100 } },
  ];
  const { runs } = planAttributionRuns(input, {
    from: 0, to: 2, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assertCovers(runs, 0, 2);
  assert.deepEqual(shape(runs), [[0, 2, '/ws/b', 'main']], 'the later entry on the line wins');
});

test('a duplicated index that is not the open run’s start is an ordinary boundary', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  // `from` is 0 and the first parsed event sits at index 2, twice — raw lines 0 and 1 produced no
  // event. The first run opens at `from` (0), so the SECOND entry on line 2 sits strictly after it
  // and splits normally. Both ranges are nonempty, which is the property that matters; the
  // in-place replacement only applies when the duplicate lands on the open run's own start.
  const input = [
    { index: 2, event: { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 } },
    { index: 2, event: { ev: 'edit', path: '/ws/b/y.ts', cwd: '/ws/a', ts: T0 + 1000 } },
  ];
  const { runs } = planAttributionRuns(input, {
    from: 0, to: 3, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assertCovers(runs, 0, 3);
  assert.deepEqual(shape(runs), [
    [0, 2, '/ws/a', 'main'],
    [2, 3, '/ws/b', 'main'],
  ]);
});

test('every run is nonempty across a fixture where every index is duplicated', () => {
  const roots = ['/ws/a', '/ws/b', '/ws/c'];
  const repoRootOf = rootsOf(roots);
  const input = [];
  for (let i = 0; i < 12; i += 1) {
    for (const root of [roots[i % 3], roots[(i + 1) % 3]]) {
      input.push({ index: i, event: { ev: 'edit', path: `${root}/f${i}.ts`, cwd: '/ws/a', ts: T0 + i * 10 } });
    }
  }
  const { runs } = planAttributionRuns(input, {
    from: 0, to: 12, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assertCovers(runs, 0, 12);
  for (const run of runs) assert.ok(run.to > run.from, `${run.from}-${run.to} is nonempty`);
});

test('unordered input is sorted by absolute index before splitting', () => {
  const repoRootOf = rootsOf(['/ws/a', '/ws/b']);
  const input = [
    { index: 1, event: { ev: 'edit', path: '/ws/b/y.ts', cwd: '/ws/a', ts: T0 + 2000 } },
    { index: 0, event: { ev: 'edit', path: '/ws/a/x.ts', cwd: '/ws/a', ts: T0 + 1000 } },
  ];
  const { runs } = planAttributionRuns(input, {
    from: 0, to: 2, cwd: '/ws/a', repoRootOf, branchAt: ALWAYS_MAIN,
  });
  assert.deepEqual(shape(runs), [
    [0, 1, '/ws/a', 'main'],
    [1, 2, '/ws/b', 'main'],
  ]);
});

test('non-finite or inverted bounds produce no runs rather than a bad window', () => {
  const opts = { cwd: '/ws/a', repoRootOf: rootsOf(['/ws/a']), branchAt: ALWAYS_MAIN };
  assert.deepEqual(planAttributionRuns([], { ...opts, from: 5, to: 2 }).runs, []);
  assert.deepEqual(planAttributionRuns([], { ...opts, from: NaN, to: 2 }).runs, []);
  assert.deepEqual(planAttributionRuns([], { ...opts, from: 0, to: undefined }).runs, []);
});

// ── 11. Resolver economy ───────────────────────────────────────────────────────────────────────

test('repoRootOf is memoized per directory and branchAt per (root, timestamp)', () => {
  const dirs = [];
  const branches = [];
  const repoRootOf = (dir) => { dirs.push(dir); return '/ws/a'; };
  const branchAt = (root, ms) => { branches.push(`${root}@${ms}`); return 'main'; };
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    events.push({ ev: 'edit', path: '/ws/a/src/x.ts', cwd: '/ws/a', ts: T0 + 1000 });
  }
  planAttributionRuns(indexed(events), {
    from: 0, to: 10, cwd: '/ws/a', repoRootOf, branchAt,
  });
  assert.deepEqual(dirs, ['/ws/a/src'], 'one lookup for ten events in one directory');
  assert.deepEqual(branches, [`/ws/a@${T0 + 1000}`], 'one branch lookup for ten events at one timestamp');
});
