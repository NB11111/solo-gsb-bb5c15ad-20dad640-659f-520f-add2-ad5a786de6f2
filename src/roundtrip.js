/**
 * Deterministic round-trip plan between a saved merge's `base` and `merged`.
 *
 * Produces two RFC 6902 patches containing only add/remove/replace:
 *  - forward:  base   -> merged
 *  - rollback: merged -> base
 *
 * Determinism rules:
 *  - object members are visited in lexicographic (UTF-16 code unit) key order
 *    and JSON Pointer tokens are escaped (~ then /) via formatPointer;
 *  - arrays are aligned with a longest-common-subsequence over deep-equal
 *    elements; surviving elements are retained untouched, so edits inside
 *    moved-looking elements are never fabricated;
 *  - array deletions are emitted against the base-side array in DESCENDING
 *    index order and insertions in ASCENDING order, so every index in the
 *    serialized patch is valid at the moment the operation executes under
 *    strict RFC 6902 semantics.
 *
 * Before a plan is returned it is actually replayed server side: the forward
 * patch applied to base must deep-equal merged and the rollback patch applied
 * to merged must deep-equal base. A failed verification throws RoundTripError;
 * such a plan is never returned and the stored record is never modified.
 */

import { deepEqual, formatPointer } from './merge.js';

export const ROUNDTRIP_CODES = Object.freeze({
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
});

export class RoundTripError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RoundTripError';
    this.code = ROUNDTRIP_CODES.VERIFICATION_FAILED;
    this.details = details;
  }
}

/* ------------------------------- diff engine ------------------------------ */

const lexicographic = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Longest common subsequence of two arrays compared by deep equality.
 * Returns a list of [baseIndex, targetIndex] pairs in ascending order.
 *
 * The DP backtrack prefers "keep" over "skip", then skips the target side
 * before the base side on ties, giving one canonical alignment for any set of
 * equally-long common subsequences.
 */
function lcsPairs(a, b) {
  const equal = Array.from({ length: a.length }, (_, i) =>
    Array.from({ length: b.length }, (_, j) => deepEqual(a[i], b[j])),
  );
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = equal[i][j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal[i][j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function diffValue(segments, base, target, ops) {
  if (deepEqual(base, target)) return;
  const bothArrays = Array.isArray(base) && Array.isArray(target);
  const bothObjects =
    base !== null &&
    target !== null &&
    typeof base === 'object' &&
    typeof target === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(target);
  if (bothObjects) {
    diffObject(segments, base, target, ops);
  } else if (bothArrays) {
    diffArray(segments, base, target, ops);
  } else {
    // Scalar change, or a container/non-container type change.
    ops.push({ op: 'replace', path: formatPointer(segments), value: structuredClone(target) });
  }
}

/**
 * Object diff. Keys are sorted lexicographically so the operation stream — and
 * therefore its serialization — is independent of member insertion order.
 */
function diffObject(segments, base, target, ops) {
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of [...keys].sort(lexicographic)) {
    const child = [...segments, key];
    const inBase = Object.prototype.hasOwnProperty.call(base, key);
    const inTarget = Object.prototype.hasOwnProperty.call(target, key);
    if (inBase && inTarget) {
      diffValue(child, base[key], target[key], ops);
    } else if (inTarget) {
      ops.push({ op: 'add', path: formatPointer(child), value: structuredClone(target[key]) });
    } else {
      ops.push({ op: 'remove', path: formatPointer(child) });
    }
  }
}

/**
 * Array diff via LCS. Removals are emitted first in descending base-index
 * order (removing a high index never shifts lower ones), then insertions in
 * strictly ascending order. After the removals every retained anchor has
 * shifted down, so each insert gap is computed against the post-removal
 * array plus the count of inserts already emitted; the serialized indices
 * therefore address the live array at each operation's execution time.
 */
function diffArray(segments, base, target, ops) {
  const pairs = lcsPairs(base, target);
  const matchedBase = new Set(pairs.map(([i]) => i));

  for (let i = base.length - 1; i >= 0; i--) {
    if (!matchedBase.has(i)) {
      ops.push({ op: 'remove', path: formatPointer([...segments, String(i)]) });
    }
  }

  // Count of removed base elements strictly before each base index: the
  // post-removal live position of retained base index i is i - removedBefore[i].
  const removedBefore = new Array(base.length).fill(0);
  let removed = 0;
  for (let i = 0; i < base.length; i++) {
    removedBefore[i] = removed;
    if (!matchedBase.has(i)) removed++;
  }

  const inserts = [];
  let cursor = 0; // next (unconsumed) target index
  const emit = (liveGap, value) =>
    inserts.push({ at: liveGap + inserts.length, value });
  for (const [baseIndex, targetIndex] of pairs) {
    // Unmatched target run just before this anchor: insert at the anchor's
    // post-removal live position (earlier inserts already accounted for).
    const liveGap = baseIndex - removedBefore[baseIndex];
    while (cursor < targetIndex) {
      emit(liveGap, target[cursor]);
      cursor++;
    }
    cursor = targetIndex + 1;
  }
  // Trailing run after the last anchor appends at the post-removal end.
  const retainedCount = pairs.length;
  while (cursor < target.length) {
    emit(retainedCount, target[cursor]);
    cursor++;
  }
  for (const ins of inserts) {
    ops.push({
      op: 'add',
      path: formatPointer([...segments, String(ins.at)]),
      value: structuredClone(ins.value),
    });
  }
}

function buildPatch(base, target) {
  const ops = [];
  diffValue([], base, target, ops);
  return ops;
}

/* ----------------------------- RFC 6902 replay ---------------------------- */

/**
 * Strict RFC 6902 applier for the add/remove/replace operations this module
 * emits. Used to actually replay the generated patches; throws RoundTripError
 * if any operation cannot be applied.
 */
export function applyPatch(doc, patch) {
  let out = structuredClone(doc);
  for (let index = 0; index < patch.length; index++) {
    const operation = patch[index];
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new RoundTripError(`operation ${index} must be an object`, { index });
    }
    const { op, path, value } = operation;
    if (typeof path !== 'string') {
      throw new RoundTripError(`operation ${index}: "path" must be a string`, { index, op });
    }
    const segments = path === '' ? [] : path.slice(1).split('/');
    // The generated patches only use plain decimal indices / member names;
    // still unescape tokens so replay follows RFC 6901 faithfully.
    const tokens = segments.map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));

    if (tokens.length === 0) {
      if (op === 'remove') {
        throw new RoundTripError('removing the document root is not supported', { index, path });
      }
      if (op !== 'add' && op !== 'replace') {
        throw new RoundTripError(`unsupported op "${op}"`, { index, op, path });
      }
      out = structuredClone(value);
      continue;
    }

    let parent = out;
    for (let k = 0; k < tokens.length - 1; k++) {
      const token = tokens[k];
      if (Array.isArray(parent)) {
        const idx = Number(token);
        if (!/^\d+$/.test(token) || !Number.isSafeInteger(idx) || idx >= parent.length) {
          throw new RoundTripError(
            `array index ${token} out of bounds at operation ${index}`,
            { index, path },
          );
        }
        parent = parent[idx];
      } else if (parent !== null && typeof parent === 'object') {
        if (!Object.prototype.hasOwnProperty.call(parent, token)) {
          throw new RoundTripError(
            `path does not exist: ${formatPointer(tokens.slice(0, k + 1))}`,
            { index, path },
          );
        }
        parent = parent[token];
      } else {
        throw new RoundTripError(`cannot traverse into ${parent === null ? 'null' : typeof parent}`, {
          index,
          path,
        });
      }
    }

    const token = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
      if (op === 'add') {
        const idx = token === '-' ? parent.length : Number(token);
        if (token !== '-' && (!/^\d+$/.test(token) || !Number.isSafeInteger(idx) || idx > parent.length)) {
          throw new RoundTripError(`invalid add index ${token} at operation ${index}`, {
            index,
            path,
          });
        }
        parent.splice(idx, 0, structuredClone(value));
        continue;
      }
      const idx = Number(token);
      if (!/^\d+$/.test(token) || !Number.isSafeInteger(idx) || idx >= parent.length) {
        throw new RoundTripError(`array index ${token} out of bounds at operation ${index}`, {
          index,
          path,
        });
      }
      if (op === 'remove') {
        parent.splice(idx, 1);
      } else if (op === 'replace') {
        parent[idx] = structuredClone(value);
      } else {
        throw new RoundTripError(`unsupported op "${op}"`, { index, op, path });
      }
      continue;
    }

    if (parent !== null && typeof parent === 'object') {
      const has = Object.prototype.hasOwnProperty.call(parent, token);
      if (op === 'remove') {
        if (!has) {
          throw new RoundTripError(`cannot remove a non-existent member: ${path}`, {
            index,
            path,
          });
        }
        delete parent[token];
      } else if (op === 'add') {
        parent[token] = structuredClone(value);
      } else if (op === 'replace') {
        if (!has) {
          throw new RoundTripError(`cannot replace a non-existent member: ${path}`, {
            index,
            path,
          });
        }
        parent[token] = structuredClone(value);
      } else {
        throw new RoundTripError(`unsupported op "${op}"`, { index, op, path });
      }
      continue;
    }

    throw new RoundTripError(
      `cannot target a member of ${parent === null ? 'null' : typeof parent} at ${path}`,
      { index, path },
    );
  }
  return out;
}

/* --------------------------------- entry --------------------------------- */

/**
 * Build and verify the round-trip plan between base and merged.
 *
 * Returns { forward, rollback, counts } where each patch is an array of plain
 * RFC 6902 operations and counts reports { forward, rollback } operation
 * totals. Both replays must verify: forward(base) === merged and
 * rollback(merged) === base, otherwise RoundTripError is thrown.
 */
export function buildRoundTripPlan(base, merged) {
  const forward = buildPatch(base, merged);
  const rollback = buildPatch(merged, base);

  const replayedForward = applyPatch(base, forward);
  if (!deepEqual(replayedForward, merged)) {
    throw new RoundTripError('forward replay did not reproduce merged', {
      stage: 'forward',
    });
  }
  const replayedBase = applyPatch(replayedForward, rollback);
  if (!deepEqual(replayedBase, base)) {
    throw new RoundTripError('rollback replay did not restore base', {
      stage: 'rollback',
    });
  }

  return {
    forward,
    rollback,
    counts: { forward: forward.length, rollback: rollback.length },
  };
}
