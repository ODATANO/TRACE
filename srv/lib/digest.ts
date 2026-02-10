import crypto from 'crypto';

/**
 * Compute a deterministic SHA-256 digest of a JSON payload.
 * Keys are sorted recursively to ensure canonical form.
 */
export function computeDigest(payload: unknown): string {
  const canonical = canonicalize(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Canonicalize a value by sorting object keys recursively.
 * Produces a deterministic JSON string regardless of key insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const sorted = Object.keys(obj).sort().map(
    key => JSON.stringify(key) + ':' + canonicalize(obj[key])
  );
  return '{' + sorted.join(',') + '}';
}
