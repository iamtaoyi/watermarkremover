/**
 * 增量 MD5（RFC 1321）—— 纯 JS，零依赖
 *
 * 为什么自己实现：浏览器 WebCrypto 只提供 SHA-1/256/384/512，**没有 MD5**，
 * 而「上传前先判断服务器是否已有同一文件」必须在本地算出 MD5。
 * 本实现支持分片 update()，可以边读边算，不需要把整个文件读进内存。
 * 正确性由 tools/md5.test.mjs 与 Node 内置 crypto 对拍验证。
 */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32) */
const K = new Int32Array(64);
for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

export class Md5 {
  constructor() {
    this.a = 0x67452301 | 0;
    this.b = 0xefcdab89 | 0;
    this.c = 0x98badcfe | 0;
    this.d = 0x10325476 | 0;
    this.buf = new Uint8Array(64);
    this.view = new DataView(this.buf.buffer);
    this.bufLen = 0;
    this.bytes = 0; // 已处理的字节数（Number 精确到 2^53，够用）
    this.M = new Int32Array(16);
  }

  /** 追加一段数据（Uint8Array） */
  update(chunk) {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.bytes += data.length;
    let off = 0;
    if (this.bufLen > 0) {
      const need = 64 - this.bufLen;
      const take = Math.min(need, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off = take;
      if (this.bufLen === 64) {
        this.#block(0);
        this.bufLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this.view = new DataView(data.buffer, data.byteOffset + off, 64);
      this.#block(0);
      off += 64;
    }
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = data.length - off;
    }
    if (!this.view || this.view.buffer !== this.buf.buffer) this.view = new DataView(this.buf.buffer);
    return this;
  }

  /** 处理 buf 中从 offset 开始的 64 字节 */
  #block(offset) {
    const v = this.view;
    const M = this.M;
    for (let i = 0; i < 16; i += 1) M[i] = v.getInt32(offset + i * 4, true);

    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;

    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i] + M[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((f << S[i]) | (f >>> (32 - S[i])))) | 0;
    }

    this.a = (this.a + a) | 0;
    this.b = (this.b + b) | 0;
    this.c = (this.c + c) | 0;
    this.d = (this.d + d) | 0;
  }

  /** 结束并返回 16 字节摘要 */
  digestBytes() {
    const bytes = this.bytes;
    const pad = new Uint8Array(((bytes % 64) < 56 ? 56 : 120) - (bytes % 64));
    pad[0] = 0x80;
    const bits = bytes * 8; // <= 2^53，精确
    const lo = bits % 4294967296;
    const hi = Math.floor(bits / 4294967296);
    const len = new Uint8Array(8);
    new DataView(len.buffer).setUint32(0, lo, true);
    new DataView(len.buffer).setUint32(4, hi, true);
    this.update(pad);
    this.update(len);

    const out = new Uint8Array(16);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, this.a, true);
    dv.setInt32(4, this.b, true);
    dv.setInt32(8, this.c, true);
    dv.setInt32(12, this.d, true);
    return out;
  }

  hex() {
    return [...this.digestBytes()].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 不改变当前状态地取当前摘要（内部用于流式场景的分段输出） */
  clone() {
    const c = new Md5();
    c.a = this.a; c.b = this.b; c.c = this.c; c.d = this.d;
    c.buf.set(this.buf); c.bufLen = this.bufLen; c.bytes = this.bytes;
    return c;
  }
}

export const md5Hex = (data) => new Md5().update(data instanceof Uint8Array ? data : new Uint8Array(data)).hex();

/** 分片读取 File/Blob 计算 MD5，onProgress 回调用于进度展示 */
export async function md5Blob(blob, { chunkSize = 8 * 1024 * 1024, onProgress, shouldAbort } = {}) {
  const md5 = new Md5();
  let offset = 0;
  while (offset < blob.size) {
    if (shouldAbort?.()) throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
    const buf = await blob.slice(offset, offset + chunkSize).arrayBuffer();
    md5.update(new Uint8Array(buf));
    offset += chunkSize;
    onProgress?.(Math.min(offset, blob.size), blob.size);
    await new Promise((r) => setTimeout(r, 0)); // 让出主线程，保证进度可以刷新
  }
  return md5.hex();
}
