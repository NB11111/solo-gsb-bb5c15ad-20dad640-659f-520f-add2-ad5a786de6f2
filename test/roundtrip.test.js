import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoundTripPlan, applyPatch } from '../src/roundtrip.js';
import { buildApp } from '../src/app.js';
import { EXAMPLE_REQUEST, EXAMPLE_CONFLICT_REQUEST } from '../src/example.js';

/* ------------------------------ diff determinism -------------------------- */

test('object members are handled in lexicographic key order (depth-first per level)', () => {
  const { forward, rollback } = buildRoundTripPlan(
    { zebra: 1, apple: 1, middle: { y: 1, a: 1 } },
    { zebra: 2, kiwi: 3, middle: { y: 1, a: 2 } },
  );
  assert.deepEqual(
    forward.map((o) => o.path),
    ['/apple', '/kiwi', '/middle/a', '/zebra'],
  );
  assert.deepEqual(
    rollback.map((o) => o.path),
    ['/apple', '/kiwi', '/middle/a', '/zebra'],
  );

  // Child members are sorted within their own object level.
  const nested = buildRoundTripPlan(
    { k: { z: 1, a: 2 } },
    { k: { z: 3, a: 4, m: 5 } },
  );
  assert.deepEqual(nested.forward.map((o) => o.path), ['/k/a', '/k/m', '/k/z']);
});

test('JSON Pointer tokens are escaped (~0 for ~, ~1 for /)', () => {
  const { forward } = buildRoundTripPlan(
    { 'a/b': 1, 'a~b': 2, 'n~1/x': 3 },
    { 'a/b': 1, 'a~b': 20, 'n~1/x': 30 },
  );
  assert.deepEqual(
    forward,
    [
      { op: 'replace', path: '/a~0b', value: 20 },
      { op: 'replace', path: '/n~01~1x', value: 30 },
    ],
  );
});

test('array LCS keeps equal elements instead of removing and re-adding them', () => {
  const { forward } = buildRoundTripPlan(
    { l: [1, 2, 3, 4] },
    { l: [9, 2, 3, 8] },
  );
  assert.deepEqual(forward, [
    { op: 'remove', path: '/l/3' },
    { op: 'remove', path: '/l/0' },
    { op: 'add', path: '/l/0', value: 9 },
    { op: 'add', path: '/l/3', value: 8 },
  ]);
});

test('array deletions are emitted descending, insertions ascending against live indices', () => {
  const { forward } = buildRoundTripPlan(
    { l: ['a', 'b', 'c'] },
    { l: ['x', 'b', 'y'] },
  );
  assert.deepEqual(forward, [
    { op: 'remove', path: '/l/2' },
    { op: 'remove', path: '/l/0' },
    { op: 'add', path: '/l/0', value: 'x' },
    { op: 'add', path: '/l/2', value: 'y' },
  ]);

  // Pure deletion / insertion patches.
  assert.deepEqual(buildRoundTripPlan([1, 2, 3], []).forward, [
    { op: 'remove', path: '/2' },
    { op: 'remove', path: '/1' },
    { op: 'remove', path: '/0' },
  ]);
  assert.deepEqual(buildRoundTripPlan([], [1, 2, 3]).forward, [
    { op: 'add', path: '/0', value: 1 },
    { op: 'add', path: '/1', value: 2 },
    { op: 'add', path: '/2', value: 3 },
  ]);
});

test('mixed inserts around retained anchors target the post-removal live index', () => {
  const { forward } = buildRoundTripPlan(
    { l: ['a', 'b', 'c', 'd'] },
    { l: ['x', 'y', 'b', 'c', 'z'] },
  );
  assert.deepEqual(forward, [
    { op: 'remove', path: '/l/3' },
    { op: 'remove', path: '/l/0' },
    { op: 'add', path: '/l/0', value: 'x' },
    { op: 'add', path: '/l/1', value: 'y' },
    { op: 'add', path: '/l/4', value: 'z' },
  ]);
});

test('nested arrays and objects recurse; equal documents yield empty patches', () => {
  const { forward, rollback, counts } = buildRoundTripPlan(
    { o: { list: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }], keep: 1 } },
    { o: { list: [{ id: 2, v: 'b' }, { id: 3, v: 'c' }], keep: 1, added: true } },
  );
  assert.deepEqual(forward, [
    { op: 'add', path: '/o/added', value: true },
    { op: 'remove', path: '/o/list/0' },
    { op: 'add', path: '/o/list/1', value: { id: 3, v: 'c' } },
  ]);
  assert.deepEqual(rollback, [
    { op: 'remove', path: '/o/added' },
    { op: 'remove', path: '/o/list/1' },
    { op: 'add', path: '/o/list/0', value: { id: 1, v: 'a' } },
  ]);
  assert.deepEqual(counts, { forward: 3, rollback: 3 });

  const empty = buildRoundTripPlan({ a: [1, 2], b: { c: true } }, { a: [1, 2], b: { c: true } });
  assert.deepEqual(empty.forward, []);
  assert.deepEqual(empty.rollback, []);
  assert.deepEqual(empty.counts, { forward: 0, rollback: 0 });
});

test('root/type changes use a single replace at ""', () => {
  assert.deepEqual(buildRoundTripPlan(1, { x: 2 }).forward, [
    { op: 'replace', path: '', value: { x: 2 } },
  ]);
  assert.deepEqual(buildRoundTripPlan({ x: 2 }, null).forward, [
    { op: 'replace', path: '', value: null },
  ]);
  assert.deepEqual(buildRoundTripPlan(null, []).rollback, [
    { op: 'replace', path: '', value: null },
  ]);
});

/* ------------------------------ verification ------------------------------ */

test('generated patches strictly replay: forward -> merged, then rollback -> base', () => {
  const pairs = [
    [{ a: 1, l: [1, 2, 3] }, { a: 9, l: [3, 1, 2, 4], k: [] }],
    [{ 'weird/~key': [{ x: 1 }] }, { 'weird/~key': [{ x: 1 }, { y: 2 }] }],
    [['a', 'b', 'c', 'b'], ['b', 'c', 'b', 'd']],
    [{ deep: { a: [1, 2], b: 2 } }, { deep: { a: [2, 1], b: 3, c: 4 } }],
  ];
  for (const [base, merged] of pairs) {
    const plan = buildRoundTripPlan(base, merged); // throws if replay fails
    // Independently re-run strict replay of each patch.
    assert.deepEqual(applyPatch(base, plan.forward), merged);
    assert.deepEqual(applyPatch(merged, plan.rollback), base);
  }
});

test('only add/remove/replace operations are ever produced', () => {
  const plan = buildRoundTripPlan(
    { a: 1, b: [1, 2], c: 'x' },
    { a: 2, b: [2, 3], d: 'y' },
  );
  for (const op of [...plan.forward, ...plan.rollback]) {
    assert.ok(['add', 'remove', 'replace'].includes(op.op), op.op);
    assert.equal(typeof op.path, 'string');
  }
});

test('plan is deterministic and a pure function of base and merged', () => {
  const base = { l: [1, 2, 3], o: { k: 'v' } };
  const merged = { l: [3, 2, 4], o: { k: 'w', q: 1 } };
  const p1 = buildRoundTripPlan(base, merged);
  const p2 = buildRoundTripPlan(base, merged);
  assert.equal(JSON.stringify(p1), JSON.stringify(p2));
});

/* --------------------------------- HTTP API ------------------------------- */

let app;

before(async () => {
  app = buildApp({ logger: false, storeMax: 100 });
  await app.ready();
});

after(async () => {
  await app.close();
});

async function postRecord(payload) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/merges', payload });
  return res;
}

test('GET round-trip-plan on the clean example returns verified patches and counts', async () => {
  const created = await postRecord(EXAMPLE_REQUEST);
  const { id } = created.json();
  const res = await app.inject({ method: 'GET', url: `/api/v1/merges/${id}/round-trip-plan` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, id);
  assert.deepEqual(body.base, EXAMPLE_REQUEST.base);
  assert.equal(body.counts.forward, body.forward.length);
  assert.equal(body.counts.rollback, body.rollback.length);

  // Re-verify with the replay engine against the saved merged document.
  assert.deepEqual(applyPatch(body.base, body.forward), body.merged);
  assert.deepEqual(applyPatch(body.merged, body.rollback), body.base);

  // Spot-check the deterministic forward stream: object keys are lexicographic
  // (features before replicas before servers), and for /servers the descending
  // removal is emitted before the ascending inserts.
  assert.deepEqual(body.forward, [
    { op: 'add', path: '/features/retries', value: 3 },
    { op: 'replace', path: '/features/tracing', value: true },
    { op: 'replace', path: '/replicas', value: 3 },
    { op: 'remove', path: '/servers/0' },
    { op: 'add', path: '/servers/0', value: { host: 'a2.internal', port: 8080 } },
    { op: 'add', path: '/servers/1', value: { host: 'b2.internal', port: 9090 } },
  ]);
  assert.deepEqual(body.rollback, [
    { op: 'remove', path: '/features/retries' },
    { op: 'replace', path: '/features/tracing', value: false },
    { op: 'replace', path: '/replicas', value: 2 },
    { op: 'remove', path: '/servers/1' },
    { op: 'remove', path: '/servers/0' },
    { op: 'add', path: '/servers/0', value: { host: 'a.internal', port: 8080 } },
  ]);
});

test('GET round-trip-plan is byte-for-byte identical on repeated requests', async () => {
  const { id } = (await postRecord(EXAMPLE_REQUEST)).json();
  const first = await app.inject({ method: 'GET', url: `/api/v1/merges/${id}/round-trip-plan` });
  const second = await app.inject({ method: 'GET', url: `/api/v1/merges/${id}/round-trip-plan` });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, second.body);
});

test('GET round-trip-plan on a conflict record returns 409 and does not modify it', async () => {
  const { id } = (await postRecord(EXAMPLE_CONFLICT_REQUEST)).json();
  const res = await app.inject({ method: 'GET', url: `/api/v1/merges/${id}/round-trip-plan` });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'Conflict');
  assert.match(res.json().message, /status "conflict"/);

  const record = (await app.inject({ method: 'GET', url: `/api/v1/merges/${id}` })).json();
  assert.equal(record.status, 'conflict');
  assert.equal(record.merged, null);
});

test('GET round-trip-plan for an unknown id returns 404', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/merges/does-not-exist/round-trip-plan',
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});
