/**
 * MD5 计算 Worker（module worker）
 * 主线程把 File/Blob 交给它（结构化克隆是零拷贝的引用），
 * 分片读取 + 增量哈希，避免大文件把主线程卡死或撑爆内存。
 */
import { Md5 } from '/md5.js';

const CHUNK = 8 * 1024 * 1024;

self.onmessage = async (event) => {
  const { id, blob } = event.data || {};
  if (!blob) return;
  const md5 = new Md5();
  const t0 = performance.now();
  let offset = 0;
  try {
    while (offset < blob.size) {
      const buf = await blob.slice(offset, offset + CHUNK).arrayBuffer();
      md5.update(new Uint8Array(buf));
      offset += CHUNK;
      const loaded = Math.min(offset, blob.size);
      self.postMessage({ id, type: 'progress', loaded, total: blob.size });
      await new Promise((r) => setTimeout(r, 0)); // 让出事件循环，进度消息才能及时送达
    }
    self.postMessage({ id, type: 'done', md5: md5.hex(), bytes: blob.size, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
