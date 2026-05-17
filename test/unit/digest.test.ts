/**
 * Unit tests for the canonical-JSON digest helpers used by TRACE to fingerprint
 * batch payloads (`originPayload`) and recall reasons. Both functions are pure;
 * no mocks needed.
 */

import { canonicalize, computeDigest } from '../../srv/lib/digest';
import crypto from 'crypto';

describe('canonicalize', () => {
  it('returns "null" for null and undefined', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(undefined)).toBe('null');
  });

  it('serializes primitives via JSON.stringify', () => {
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(0)).toBe('0');
  });

  it('escapes special characters in strings', () => {
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize('line1\nline2')).toBe('"line1\\nline2"');
  });

  it('preserves array element order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize(['b', 'a'])).toBe('["b","a"]');
  });

  it('sorts object keys lexicographically (top-level)', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts object keys recursively (nested)', () => {
    const input = { z: { y: 1, x: 2 }, a: [{ d: 4, c: 3 }] };
    expect(canonicalize(input)).toBe('{"a":[{"c":3,"d":4}],"z":{"x":2,"y":1}}');
  });

  it('produces identical output regardless of insertion order', () => {
    const a = canonicalize({ name: 'X', batch: 1, ts: 5 });
    const b = canonicalize({ ts: 5, batch: 1, name: 'X' });
    const c = canonicalize({ batch: 1, name: 'X', ts: 5 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('handles empty containers', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });
});

describe('computeDigest', () => {
  it('produces a 64-char lowercase-hex sha256 string', () => {
    const hash = computeDigest({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same payload, same hash', () => {
    const payload = { batchId: 'b-1', step: 0 };
    expect(computeDigest(payload)).toBe(computeDigest(payload));
  });

  it('is insensitive to key insertion order', () => {
    const a = computeDigest({ name: 'X', batch: 1, ts: 5 });
    const b = computeDigest({ ts: 5, name: 'X', batch: 1 });
    expect(a).toBe(b);
  });

  it('changes when payload content changes', () => {
    const a = computeDigest({ batch: 1 });
    const b = computeDigest({ batch: 2 });
    expect(a).not.toBe(b);
  });

  it('distinguishes between {a: 1} and {a: "1"}', () => {
    expect(computeDigest({ a: 1 })).not.toBe(computeDigest({ a: '1' }));
  });

  it('matches an independently computed sha256 of the canonical form', () => {
    const payload = { x: [1, 2, 3], y: { nested: true } };
    const canonical = canonicalize(payload);
    const expected = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(computeDigest(payload)).toBe(expected);
  });

  it('hashes nested arrays and primitives without losing entropy', () => {
    const variantA = { items: [{ id: 1 }, { id: 2 }] };
    const variantB = { items: [{ id: 2 }, { id: 1 }] };
    // Array order is part of the payload → different hash
    expect(computeDigest(variantA)).not.toBe(computeDigest(variantB));
  });

  it('treats null and undefined values identically (both serialize to "null")', () => {
    expect(computeDigest({ a: null })).toBe(computeDigest({ a: undefined }));
  });
});
