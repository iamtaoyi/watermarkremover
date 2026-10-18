/**
 * 轻量令牌桶限流（内存，零依赖）
 * 目标：防单一用户/IP/突发流量把 2 核小机器打瘫。
 */
const buckets = new Map();   // key -> { tokens, ts }
let lastSweep = 0;

export function take(key, { rate = 2, burst = 60 } = {}) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, ts: now }; buckets.set(key, b); }
  // 按 elapsed 补充令牌
  const elapsed = (now - b.ts) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(burst, b.tokens + elapsed * rate);
    b.ts = now;
  }
  if (b.tokens < 1) {
    // 定期清理空闲桶，避免内存增长
    if (now - lastSweep > 60000) {
      lastSweep = now;
      for (const [k, v] of buckets) if (now - v.ts > 10 * 60000) buckets.delete(k);
    }
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / rate) };
  }
  b.tokens -= 1;
  return { ok: true, remaining: Math.floor(b.tokens) };
}

export function stats() { return { buckets: buckets.size }; }
