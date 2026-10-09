import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, CRAWLER_TARGETS, TIER1, TIER2, ALL } from './cli-args.js';

test('resolveTarget: usage branch for missing/empty/help', () => {
  assert.deepEqual(resolveTarget(undefined), { kind: 'usage' });
  assert.deepEqual(resolveTarget(null), { kind: 'usage' });
  assert.deepEqual(resolveTarget(''), { kind: 'usage' });
  assert.deepEqual(resolveTarget('--help'), { kind: 'usage' });
  assert.deepEqual(resolveTarget('-h'), { kind: 'usage' });
  assert.deepEqual(resolveTarget('help'), { kind: 'usage' });
});

test('resolveTarget: all-tier1 returns tier1 group with TIER1 targets', () => {
  const r = resolveTarget('all-tier1');
  assert.equal(r.kind, 'all');
  assert.equal(r.group, 'tier1');
  assert.deepEqual(r.targets, TIER1);
});

test('all-tier1 excludes seatgeek and brooklyn-library', () => {
  const r = resolveTarget('all-tier1');
  assert.ok(!r.targets.includes('seatgeek'));
  assert.ok(!r.targets.includes('brooklyn-library'));
});

test('resolveTarget: all-tier2 returns tier2 group with TIER2 targets', () => {
  const r = resolveTarget('all-tier2');
  assert.equal(r.kind, 'all');
  assert.equal(r.group, 'tier2');
  assert.deepEqual(r.targets, TIER2);
  assert.deepEqual(r.targets, ['westsiderag', 'nyccom']);
});

test('resolveTarget: all returns all group with ALL targets', () => {
  const r = resolveTarget('all');
  assert.equal(r.kind, 'all');
  assert.equal(r.group, 'all');
  assert.deepEqual(r.targets, ALL);
  assert.deepEqual(ALL, [...TIER1, ...TIER2]);
});

test('resolveTarget: known crawler returns crawler action', () => {
  assert.deepEqual(resolveTarget('nyc-parks'), { kind: 'crawler', name: 'nyc-parks' });
  assert.deepEqual(resolveTarget('nyccom'), { kind: 'crawler', name: 'nyccom' });
  assert.deepEqual(resolveTarget('seatgeek'), { kind: 'crawler', name: 'seatgeek' });
});

test('resolveTarget: unknown target returns unknown action', () => {
  assert.deepEqual(resolveTarget('bogus'), { kind: 'unknown', name: 'bogus' });
  assert.deepEqual(resolveTarget('all-tier3'), { kind: 'unknown', name: 'all-tier3' });
});

test('CRAWLER_TARGETS: covers every known crawler exactly once', () => {
  assert.ok(CRAWLER_TARGETS.length > 0);
  assert.equal(new Set(CRAWLER_TARGETS).size, CRAWLER_TARGETS.length);
  for (const name of CRAWLER_TARGETS) {
    assert.deepEqual(resolveTarget(name), { kind: 'crawler', name });
  }
});

test('TIER1 and TIER2 are subsets of CRAWLER_TARGETS', () => {
  for (const name of [...TIER1, ...TIER2]) {
    assert.ok(CRAWLER_TARGETS.includes(name), `${name} missing from CRAWLER_TARGETS`);
  }
});

test('ALL contains every tier crawler and the Playwright tier', () => {
  assert.deepEqual(ALL, [...TIER1, ...TIER2]);
  assert.ok(ALL.includes('westsiderag'));
  assert.ok(ALL.includes('nyccom'));
});
