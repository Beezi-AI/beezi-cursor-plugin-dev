import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveIntervals,
  claimIntervals,
  mergeIntervals,
  subtractIntervals,
  totalMs,
  MAX_COVERED_INTERVALS,
} from '../lib/active-time.mjs';

const S = 1000;
const IDLE = 300 * S; // lib/timing.mjs IDLE_GAP_SEC, in millis

// ─── buildActiveIntervals ───────────────────────────────────────────────────

test('buildActiveIntervals joins sub-threshold gaps into one run', () => {
  const iv = buildActiveIntervals([0, 10 * S, 20 * S], IDLE);
  assert.deepEqual(iv, [[0, 20 * S]]);
  assert.equal(totalMs(iv), 20 * S);
});

test('buildActiveIntervals splits on an idle gap and drops it', () => {
  const iv = buildActiveIntervals([0, 10 * S, 10 * S + IDLE, 10 * S + IDLE + 5 * S], IDLE);
  assert.deepEqual(iv, [[0, 10 * S], [10 * S + IDLE, 10 * S + IDLE + 5 * S]]);
  assert.equal(totalMs(iv), 15 * S, 'the idle stretch itself is not active time');
});

test('buildActiveIntervals treats a gap exactly at the threshold as idle', () => {
  assert.deepEqual(buildActiveIntervals([0, IDLE], IDLE), []);
});

test('buildActiveIntervals ignores order and duplicate timestamps', () => {
  // Two hook registries append the same moment twice, milliseconds apart, and the sidecar is written
  // by concurrent processes — neither order nor uniqueness may be assumed.
  const iv = buildActiveIntervals([20 * S, 0, 10 * S, 10 * S], IDLE);
  assert.deepEqual(iv, [[0, 20 * S]]);
});

test('buildActiveIntervals returns nothing for fewer than two timestamps', () => {
  assert.deepEqual(buildActiveIntervals([], IDLE), []);
  assert.deepEqual(buildActiveIntervals([5 * S], IDLE), []);
});

// ─── mergeIntervals ─────────────────────────────────────────────────────────

test('mergeIntervals coalesces overlapping and touching spans, drops empties', () => {
  assert.deepEqual(
    mergeIntervals([[30, 40], [0, 10], [10, 15], [5, 8], [50, 50]]),
    [[0, 15], [30, 40]],
  );
});

// ─── subtractIntervals ──────────────────────────────────────────────────────

test('subtractIntervals returns the input when nothing is covered', () => {
  assert.deepEqual(subtractIntervals([[10, 20]], []), [[10, 20]]);
});

test('subtractIntervals removes a fully covered span', () => {
  assert.deepEqual(subtractIntervals([[10, 20]], [[0, 100]]), []);
});

test('subtractIntervals keeps the head and tail around a covered middle', () => {
  assert.deepEqual(subtractIntervals([[0, 100]], [[40, 60]]), [[0, 40], [60, 100]]);
});

test('subtractIntervals handles several covered chunks inside one span', () => {
  assert.deepEqual(
    subtractIntervals([[0, 100]], [[10, 20], [30, 40], [90, 120]]),
    [[0, 10], [20, 30], [40, 90]],
  );
});

test('subtractIntervals advances across multiple input spans', () => {
  assert.deepEqual(
    subtractIntervals([[0, 10], [20, 30], [40, 50]], [[5, 25]]),
    [[0, 5], [25, 30], [40, 50]],
  );
});

test('subtractIntervals ignores coverage that ends before the span starts', () => {
  assert.deepEqual(subtractIntervals([[100, 110]], [[0, 50]]), [[100, 110]]);
});

// ─── the property that matters: sum of residuals == union ───────────────────

test('overlapping parent and subagent spans bill each second exactly once', () => {
  // The Cursor case the next round wires: the parent blocks 0..520s on the Task calls while six
  // workers run inside that window, overlapping each other because `is_parallel_worker` fans them
  // out together. The main segment is enqueued first and keeps its full span; each subagent bills
  // only what no earlier segment claimed.
  const main = [[0, 520 * S]];
  const agents = [
    [[0, 162 * S]],
    [[8 * S, 222 * S]],
    [[17 * S, 482 * S]],
    [[26 * S, 249 * S]],
    [[35 * S, 520 * S]],
    [[43 * S, 178 * S]],
  ];

  let covered = [];
  let billed = 0;
  for (const intervals of [main, ...agents]) {
    billed += totalMs(subtractIntervals(intervals, covered));
    covered = claimIntervals(covered, intervals);
  }

  const naiveSum = [main, ...agents].reduce((acc, iv) => acc + totalMs(iv), 0);
  assert.equal(billed, 520 * S, 'billed time equals the wall-clock union');
  assert.equal(naiveSum, 2204 * S, 'summing every overlapping span reports 4.24x the real day');
  assert.equal(totalMs(covered), 520 * S);
});

test('a subagent outliving the parent still bills its uncovered tail', () => {
  // The parent goes idle mid-fan-out (a gap over the threshold), so its own span stops early; the
  // worker must contribute the remainder rather than be zeroed out.
  const main = [[0, 100 * S]];
  const agent = [[50 * S, 400 * S]];

  const covered = claimIntervals([], main);
  const residual = subtractIntervals(agent, covered);
  assert.deepEqual(residual, [[100 * S, 400 * S]]);
  assert.equal(totalMs(main) + totalMs(residual), 400 * S);
});

test('coverage is only claimed on a successful enqueue', () => {
  // A segment that failed to reach the queue must not swallow its window for every later segment —
  // otherwise one write failure silently zeroes the wall clock of the whole fan-out behind it.
  const main = [[0, 100 * S]];
  const agent = [[0, 100 * S]];

  let covered = [];
  const mainFailedToEnqueue = true;
  if (!mainFailedToEnqueue) covered = claimIntervals(covered, main);
  assert.equal(totalMs(subtractIntervals(agent, covered)), 100 * S);
});

// ─── claimIntervals ─────────────────────────────────────────────────────────

test('claimIntervals merges into existing coverage', () => {
  assert.deepEqual(claimIntervals([[0, 10]], [[8, 20], [40, 50]]), [[0, 20], [40, 50]]);
});

test('claimIntervals caps stored coverage, keeping the most recent', () => {
  // Coverage is persisted in per-session state on disk, so a pathological session must not grow it
  // without bound. Activity only moves forward, so the oldest entries can no longer overlap.
  const many = Array.from({ length: MAX_COVERED_INTERVALS + 88 }, (_, i) => [i * 1000, i * 1000 + 10]);
  const capped = claimIntervals([], many);
  assert.equal(capped.length, MAX_COVERED_INTERVALS);
  assert.deepEqual(capped[capped.length - 1], [(many.length - 1) * 1000, (many.length - 1) * 1000 + 10]);
  assert.deepEqual(capped[0], [88 * 1000, 88 * 1000 + 10]);
});

test('the cap holds however many times coverage is claimed', () => {
  let covered = [];
  for (let round = 0; round < 20; round++) {
    const batch = Array.from({ length: 100 }, (_, i) => {
      const base = (round * 100 + i) * 10_000;
      return [base, base + 10];
    });
    covered = claimIntervals(covered, batch);
    assert.ok(covered.length <= MAX_COVERED_INTERVALS, `round ${round} grew past the bound`);
  }
  assert.equal(covered.length, MAX_COVERED_INTERVALS);
});
