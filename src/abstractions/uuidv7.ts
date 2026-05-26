// ADR-203 §D6: UUIDv7 — time-ordered UUID per RFC 9562. Used as the
// canonical `eventId` for the Honker pubsub substrate (ADR-202) so
// consumer-side `WHERE eventId > last_processed` queries on streams
// sort lexicographically by creation time, and absence-detection
// windowing can read the embedded millisecond timestamp without a
// separate column.
//
// Format (RFC 9562 §5.7):
//   - 48 bits: unix-timestamp-ms (big-endian)
//   - 4  bits: version (0b0111 = 7)
//   - 12 bits: random / rand_a
//   - 2  bits: variant (0b10)
//   - 62 bits: random / rand_b
//
// Pinned as the **only** ID generator for `eventId` per ADR-202 §D5 +
// ADR-203 §D6 — no per-call-site UUIDv4 / nanoid drift.

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    s += HEX.charAt(b >>> 4) + HEX.charAt(b & 0x0f);
  }
  return s;
}

/**
 * Generate a UUIDv7. Time-ordered + globally unique.
 *
 * @param nowMs Optional explicit timestamp (epoch ms). Defaults to `Date.now()`.
 *              Test-injection seam — callers must not pass this in production.
 * @param rand  Optional 10-byte random source. Defaults to `crypto.getRandomValues`.
 *              Test-injection seam — callers must not pass this in production.
 *
 * @returns A 36-char hyphenated lowercase UUID string.
 */
export function uuidv7(nowMs?: number, rand?: Uint8Array): string {
  const ts = nowMs ?? Date.now();
  const r = rand ?? crypto.getRandomValues(new Uint8Array(10));
  if (r.length !== 10) {
    throw new Error(`uuidv7: rand must be 10 bytes, got ${r.length}`);
  }

  const bytes = new Uint8Array(16);
  // 48-bit timestamp (ms) — big-endian
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  // Version (4 bits = 0b0111) + first 4 bits of rand_a
  bytes[6] = 0x70 | ((r[0] as number) & 0x0f);
  // Last 8 bits of rand_a
  bytes[7] = r[1] as number;
  // Variant (2 bits = 0b10) + first 6 bits of rand_b
  bytes[8] = 0x80 | ((r[2] as number) & 0x3f);
  // Remaining 56 bits of rand_b
  bytes[9] = r[3] as number;
  bytes[10] = r[4] as number;
  bytes[11] = r[5] as number;
  bytes[12] = r[6] as number;
  bytes[13] = r[7] as number;
  bytes[14] = r[8] as number;
  bytes[15] = r[9] as number;

  const h = toHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Extract the embedded millisecond timestamp from a UUIDv7. Useful
 * for absence-detection windowing without a separate timestamp column.
 *
 * @returns Epoch milliseconds, or `null` if the input isn't a v7 UUID.
 */
export function uuidv7Timestamp(id: string): number | null {
  // Strip hyphens, validate length + version nibble
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return null;
  if (hex[12] !== "7") return null;
  // First 12 hex chars = 48-bit big-endian millisecond timestamp
  const ts = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ts) ? ts : null;
}
