/**
 * Minimal protobuf wire-format decoder.
 * Faithful TypeScript port of anichsdk/wire.go from the reverse-engineered SDK.
 *
 * Supports the four wire types used by the Anich API:
 *   0 varint, 1 fixed64, 2 length-delimited (bytes/string/message), 5 fixed32
 *
 * The Anich service sometimes returns protobuf as a JSON array of byte numbers
 * (e.g. /vod/{id}/{episode}); `normalizeWireData` handles that case.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

export interface WireField {
  num: number;
  wire: number;
  varint: bigint;
  fixed64: bigint;
  fixed32: number;
  bytes: Uint8Array;
}

/** If `data` is a JSON byte array (starts with `[`), parse it into raw bytes. */
export function normalizeWireData(data: Uint8Array): Uint8Array {
  // Trim ASCII whitespace.
  let start = 0;
  let end = data.length;
  while (start < end && (data[start] === 32 || data[start] === 9 || data[start] === 10 || data[start] === 13)) start++;
  while (end > start && (data[end - 1] === 32 || data[end - 1] === 9 || data[end - 1] === 10 || data[end - 1] === 13)) end--;
  if (end <= start || data[start] !== 0x5b /* [ */) return data;

  const text = new TextDecoder().decode(data.subarray(start, end));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return data;
  }
  if (!Array.isArray(parsed)) return data;
  const out = new Uint8Array(parsed.length);
  for (let i = 0; i < parsed.length; i++) {
    const n = parsed[i];
    if (typeof n !== "number" || n < 0 || n > 255 || !Number.isInteger(n)) {
      return data;
    }
    out[i] = n;
  }
  return out;
}

function readVarint(data: Uint8Array, offset: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < data.length - offset && i < 10; i++) {
    const b = data[offset + i];
    if (i === 9 && b > 1) return null; // overflow
    value |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (b < 0x80) return { value, next: offset + i + 1 };
  }
  return null;
}

export function nextField(data: Uint8Array, offset: number): { field: WireField; next: number } | null {
  const keyRes = readVarint(data, offset);
  if (!keyRes) return null;
  let pos = keyRes.next;
  const num = Number(keyRes.value >> 3n);
  const wire = Number(keyRes.value & 0x7n);
  if (num <= 0) return null;

  const field: WireField = { num, wire, varint: 0n, fixed64: 0n, fixed32: 0, bytes: new Uint8Array() };

  switch (wire) {
    case WIRE_VARINT: {
      const v = readVarint(data, pos);
      if (!v) return null;
      field.varint = v.value;
      return { field, next: v.next };
    }
    case WIRE_FIXED64: {
      if (data.length - pos < 8) return null;
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[pos + i]);
      field.fixed64 = v;
      return { field, next: pos + 8 };
    }
    case WIRE_BYTES: {
      const l = readVarint(data, pos);
      if (!l) return null;
      pos = l.next;
      const len = Number(l.value);
      if (data.length - pos < len) return null;
      field.bytes = data.subarray(pos, pos + len);
      return { field, next: pos + len };
    }
    case WIRE_FIXED32: {
      if (data.length - pos < 4) return null;
      let v = 0;
      for (let i = 3; i >= 0; i--) v = (v * 256) + data[pos + i];
      field.fixed32 = v;
      return { field, next: pos + 4 };
    }
    default:
      return null;
  }
}

export function fieldString(f: WireField): string | null {
  if (f.wire !== WIRE_BYTES) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(f.bytes);
}

export function fieldDouble(f: WireField): number | null {
  if (f.wire !== WIRE_FIXED64) return null;
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, f.fixed64, true);
  return view.getFloat64(0, true);
}

export function fieldVarintNum(f: WireField): number | null {
  if (f.wire !== WIRE_VARINT) return null;
  return Number(f.varint);
}

export function fieldVarintBool(f: WireField): boolean | null {
  if (f.wire !== WIRE_VARINT) return null;
  return f.varint !== 0n;
}

/** Iterate all top-level fields of a protobuf message buffer. */
export function* iterateFields(data: Uint8Array): Generator<WireField> {
  let offset = 0;
  while (offset < data.length) {
    const res = nextField(data, offset);
    if (!res) return;
    yield res.field;
    offset = res.next;
  }
}
