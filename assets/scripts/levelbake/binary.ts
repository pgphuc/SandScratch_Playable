// Writer/reader nhị phân cấp thấp cho level-bake. Engine-agnostic: chỉ dùng
// Uint8Array/DataView, KHÔNG dùng Buffer của Node (decode.ts phải chạy được
// trong Cocos/browser).
//
// Varint = LEB128 không dấu. Số có dấu dùng zigzag trước khi ghi varint,
// đúng chuẩn protobuf (n>=0 -> 2n, n<0 -> -2n-1).

export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  /** LEB128 không dấu. */
  varUint(v: number): void {
    if (v < 0 || !Number.isFinite(v)) throw new Error(`varUint âm hoặc không hữu hạn: ${v}`);
    let n = v;
    while (n >= 0x80) {
      this.u8((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.u8(n);
  }

  /** Zigzag + LEB128, hỗ trợ số âm. */
  varInt(v: number): void {
    const zz = v >= 0 ? v * 2 : -v * 2 - 1;
    this.varUint(zz);
  }

  f64(v: number): void {
    this.ensure(8);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8);
    dv.setFloat64(0, v, true);
    this.len += 8;
  }

  u32(v: number): void {
    this.ensure(4);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 4);
    dv.setUint32(0, v >>> 0, true);
    this.len += 4;
  }

  /** varUint length-prefix + UTF-8 bytes. */
  str(s: string): void {
    const enc = new TextEncoder().encode(s);
    this.varUint(enc.length);
    this.bytes(enc);
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  private pos = 0;
  private buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    return this.buf[this.pos++];
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  bytes(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  varUint(): number {
    let shift = 1;
    let result = 0;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) break;
      shift *= 128;
    }
    return result;
  }

  varInt(): number {
    const zz = this.varUint();
    return zz % 2 === 0 ? zz / 2 : -(zz + 1) / 2;
  }

  f64(): number {
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return dv.getFloat64(0, true);
  }

  u32(): number {
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    this.pos += 4;
    return dv.getUint32(0, true);
  }

  str(): string {
    const n = this.varUint();
    const b = this.bytes(n);
    return new TextDecoder().decode(b);
  }
}

// ---- base64 cross-env (Node hoặc browser/Cocos, không phụ thuộc Buffer khi có atob/btoa) ----

export function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as any;
  if (typeof g.Buffer !== 'undefined') {
    return g.Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return g.btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const g = globalThis as any;
  if (typeof g.Buffer !== 'undefined') {
    const buf = g.Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = g.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
