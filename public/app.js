/* ============================================================================
 * ClipFlow 批量版前端
 *   ① 选择/拖入多个视频（≤ 上限），逐个 MD5 → 秒传预检 → 上传
 *   ② 上传齐了自动建批次（服务端按内容去重，内容相同的行共享同一个任务）
 *   ③ 轮询 GET /api/batches/:id（一次拿整批），渲染列表与汇总
 *   ④ 行内：预览（展开源/目标对比，同时只开一条）+ 三态共享按钮（开始/停止/下载）
 *   ⑤ 批次级：勾选任务后用「批量开始 / 批量取消」（两个独立按钮，不随单任务状态改名）
 * ========================================================================== */

const $ = (sel) => document.querySelector(sel);

const el = {
  authGate: $('#authGate'), authForm: $('#authForm'), phoneInput: $('#phoneInput'), passwordInput: $('#passwordInput'), registerBtn: $('#registerBtn'),
  loginBtn: $('#loginBtn'), authError: $('#authError'), authSessionEnd: $('#authSessionEnd'),
  appShell: $('#appShell'), sessionLeft: $('#sessionLeft'), logoutBtn: $('#logoutBtn'), buildTag: $('#buildTag'),
  uploadCard: $('#uploadCard'), dropzone: $('#dropzone'), fileInput: $('#fileInput'),
  dropHint: $('#dropHint'), quota: $('#quota'),
  erasePreset: $('#erasePreset'), eraseHint: $('#eraseHint'),
  batchCard: $('#batchCard'), batchSub: $('#batchSub'), batchPill: $('#batchPill'), notice: $('#notice'),
  diskWarn: $('#diskWarn'),
  bigDone: $('#bigDone'), cDone: $('#cDone'), cRun: $('#cRun'), cUp: $('#cUp'),
  cQueued: $('#cQueued'), cIdle: $('#cIdle'), cBad: $('#cBad'), eta: $('#eta'), bar: $('#bar'),
  list: $('#list'), diskInfo: $('#diskInfo'),
  batchStart: $('#batchStart'), batchCancel: $('#batchCancel'), batchDelete: $('#batchDelete'),
  checkAll: $('#checkAll'), selNote: $('#selNote'),
  toast: $('#toast'),
};

const state = {
  config: null,
  session: { authenticated: false },
  items: [],          // 本地上传队列（批次建立前）
  batchId: null,
  batch: null,
  rows: [],           // 服务端返回的行（批次建立后）
  openKey: null,      // 当前展开预览的行 key
  downloading: new Set(),   // 正在下载的任务（防止重复点下载）
  selected: new Set(),// 勾选的任务（批量开始/批量取消只针对它们）
  pollTimer: null,
  tickTimer: null,
};

const STORE_KEY = 'clipflow.batchId';

/* ---------------------------------------------------------------- 小工具 */
const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
};
const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
};
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('is-on'), 2200);
}
function setNotice(msg) {
  el.notice.hidden = !msg;
  el.notice.textContent = msg || '';
}

/** 磁盘是否低于保护线（低于则暂停接收新任务：上传/建批次/开始任务都会被服务端拒绝） */
function diskState() {
  const free = state.batch?.disk?.free ?? state.config?.disk?.free ?? null;
  const minFree = state.config?.disk?.minFree ?? 5 * 1024 ** 3;
  return { free, minFree, low: free !== null && free < minFree };
}
function renderDiskWarn() {
  const d = diskState();
  if (!el.diskWarn) return;
  el.diskWarn.hidden = !d.low;
  if (d.low) {
    el.diskWarn.textContent = `服务器磁盘空间不足（剩余 ${fmtBytes(d.free)}，低于 ${fmtBytes(d.minFree)} 保护线），已暂停接收新任务，请联系管理员清理`;
  }
}
/**
 * 按钮防连点：
 *   · markBusy  —— 一进入处理就禁用并改文案，第二次点击根本进不来
 *   · clearBusy —— 结束后恢复（随后的 render 会用最新状态重建按钮）
 * 再加一层全局捕获拦截：任何处于 busy 的按钮/链接，点击一律吞掉。
 */
function markBusy(btn, text) {
  if (!btn) return false;
  if (btn.dataset.busy === '1') return false;
  btn.dataset.busy = '1';
  btn.dataset.prevText = btn.textContent;
  btn.disabled = true;
  if (text) btn.textContent = text;
  return true;
}
function clearBusy(btn) {
  if (!btn) return;
  delete btn.dataset.busy;
  if (btn.dataset.prevText) { btn.textContent = btn.dataset.prevText; delete btn.dataset.prevText; }
}
document.addEventListener('click', (e) => {
  const hit = e.target.closest?.('[data-busy="1"]');
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------------- 鉴权 */
let sessionEndsAt = null;
let loginPending = false;

async function api(path, opts = {}) {
  // 每个请求都带超时：服务器/网络不响应时界面也能自己恢复，不会一直挂着
  const { timeoutMs = 20000, ...rest } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...rest,
      signal: ctrl.signal,
      headers: { ...(rest.body ? { 'content-type': 'application/json' } : {}), ...(rest.headers || {}) },
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw Object.assign(new Error('请求超时（服务器无响应）'), { code: 'TIMEOUT' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    showLogin('会话已过期，请重新输入访问 Token');
    throw Object.assign(new Error('未登录或会话已过期'), { code: 'UNAUTHORIZED' });
  }
  return res;
}
async function jsonApi(path, opts) {
  const res = await api(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function showLogin(message) {
  stopPolling();
  el.appShell.hidden = true;
  el.authGate.hidden = false;
  if (message) {
    el.authError.textContent = message;
    el.authError.hidden = false;
  }
}
function showApp() {
  el.authGate.hidden = true;
  el.appShell.hidden = false;
  el.authError.hidden = true;
}
function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function startTicker() {
  clearInterval(state.tickTimer);
  state.tickTimer = setInterval(() => {
    if (!sessionEndsAt) return;
    const left = sessionEndsAt - Date.now();
    el.sessionLeft.textContent = fmtCountdown(left);
    if (left <= 0) showLogin('会话已过期，请重新输入访问 Token');
  }, 1000);
}

async function login(phone, password) {
  loginPending = true;
  el.loginBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password }),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    sessionEndsAt = Date.parse(data.expiresAt);
    el.sessionLeft.textContent = fmtCountdown(sessionEndsAt - Date.now());
    return true;
  } finally {
    el.loginBtn.disabled = false;
    loginPending = false;
  }
}

async function bootstrap() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const data = await res.json();
    if (loginPending || state.session.authenticated) return;
    if (data.authenticated) {
      state.session = data;
      sessionEndsAt = Date.parse(data.expiresAt);
      showApp();
      await init();
    } else {
      if (data.endAt) {
        el.authSessionEnd.textContent = new Date(data.endAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      }
      showLogin();
    }
  } catch {
    showLogin();
  }
}

/* ---------------------------------------------------------------- 初始化 */
async function init() {
  state.config = await jsonApi('/api/config');
  el.buildTag.textContent = state.config.build || '';
  const exts = (state.config.allowedExtensions || []).map((e) => e.slice(1).toUpperCase()).join(' / ');
  el.dropHint.textContent = `支持 ${exts}，单个最大 ${fmtBytes(state.config.maxUploadBytes)}，一批最多 ${state.config.maxBatchSize || 10} 个`;
  if (state.config.eraseReady === false) {
    setNotice(`去字幕服务尚未就绪（缺少${(state.config.eraseMissing || []).join('、')}），暂时无法开始任务，请联系管理员。`);
  }
  startTicker();
  render();
  await restore();
}

/* ============================================================================
 * 上传阶段：时长 → MD5 → 秒传预检 → 上传
 * ========================================================================== */
function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(val); };
    v.addEventListener('loadedmetadata', () => {
      const d = Number(v.duration);
      done(Number.isFinite(d) && d > 0 ? Math.round(d) : null);
    }, { once: true });
    v.addEventListener('error', () => done(null), { once: true });
    setTimeout(() => done(null), 15000);
    v.src = url;
  });
}

let workerSeq = 0;
const pendingHash = new Map();
const HASH_PARALLEL = 3;          // 多个文件同时算 MD5（最多 3 个 worker）
let hashWorkers = null;
let hashTurn = 0;
function hashFile(file, onProgress) {
  if (hashWorkers === null) {
    hashWorkers = [];
    for (let i = 0; i < HASH_PARALLEL; i += 1) {
      try {
        const w = new Worker('/md5-worker.js', { type: 'module' });
        w.onmessage = (e) => {
          const { id, type, loaded, total, md5, message } = e.data || {};
          const job = pendingHash.get(id);
          if (!job) return;
          if (type === 'progress') job.onProgress(loaded, total);
          else if (type === 'done') { pendingHash.delete(id); job.resolve(md5); }
          else { pendingHash.delete(id); job.reject(new Error(message || 'MD5 计算失败')); }
        };
        hashWorkers.push(w);
      } catch { /* 不支持 Worker 就退化为主线程 */ }
    }
  }
  if (hashWorkers.length) {
    const id = ++workerSeq;
    const w = hashWorkers[hashTurn++ % hashWorkers.length];
    return new Promise((resolve, reject) => {
      pendingHash.set(id, { resolve, reject, onProgress });
      w.postMessage({ id, blob: file });
    });
  }
  return md5BlobLazy(file, onProgress);   // 无 Worker 环境的兜底
}
async function md5BlobLazy(file, onProgress) {
  const { md5Blob } = await import('/md5.js');
  return md5Blob(file, { onProgress });
}

function acceptFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const max = state.config?.maxBatchSize || 30;
  const allowed = new Set(state.config?.allowedExtensions || []);
  const maxBytes = state.config?.maxUploadBytes || 100 * 1024 ** 2;
  const used = viewRows().length;      // 含已并入批次的行 + 还在上传的行
  const free = max - used;
  if (free <= 0) return toast(`一批最多 ${max} 个文件`);
  const accepted = [];
  for (const f of files) {
    if (accepted.length >= free) break;
    const ext = `.${String(f.name).split('.').pop().toLowerCase()}`;
    if (!allowed.has(ext)) { toast(`不支持的文件类型：${f.name}`); continue; }
    if (f.size > maxBytes) { toast(`${f.name} 超过单文件上限 ${fmtBytes(maxBytes)}`); continue; }
    accepted.push(f);
  }
  if (files.length > free) toast(`一批最多 ${max} 个，已忽略 ${files.length - free} 个`);
  if (!accepted.length) return;
  accepted.forEach((f, i) => {
    state.items.push({
      key: `it_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      file: f, name: f.name, size: f.size, durationSec: null,
      phase: 'queued', uploadPct: 0, hashPct: 0, stageText: '等待上传', fileId: null, error: null,
    });
  });
  if (state.config?.eraseReady !== false) setNotice('');
  render();
  processQueue();
}

let uploadRunning = 0;
async function processQueue() {
  // 多个文件同时上传（并发度由服务端下发，默认 4）；上传完只是"待开始"，不会自动调接口
  const MAX_PARALLEL = Math.max(1, Number(state.config?.uploadConcurrency) || 4);
  while (uploadRunning < MAX_PARALLEL) {
    const next = state.items.find((it) => it.phase === 'queued');
    if (!next) break;
    next.phase = 'hashing';
    next.stageText = '计算 MD5（本地）';
    render();
    uploadRunning += 1;
    runUpload(next)
      .catch((err) => {
        next.phase = 'failed';
        next.error = err.message || String(err);
        next.stageText = '上传失败';
      })
      .finally(() => {
        uploadRunning -= 1;
        render();
        processQueue();
        ensureBatch();
      });
  }
}

async function runUpload(item) {
  item.durationSec = await probeDuration(item.file);
  const md5 = await hashFile(item.file, (loaded, total) => {
    item.hashPct = total ? Math.round((loaded / total) * 100) : 0;
    item.stageText = `计算 MD5（本地） ${item.hashPct}%`;
    render();
  });
  item.md5 = md5;

  const pre = await jsonApi('/api/uploads/precheck', {
    method: 'POST',
    body: JSON.stringify({ md5, name: item.name }),
  });
  if (pre.exists && pre.file) {
    item.fileId = pre.file.id;
    item.phase = 'uploaded';
    item.deduped = true;
    item.stageText = `秒传命中，省下 ${fmtBytes(pre.savedBytes ?? item.size)}`;
    render();
    return;
  }

  item.phase = 'uploading';
  item.stageText = '上传中';
  render();
  const res = await uploadFile(item, md5);
  item.fileId = res.file.id;
  item.phase = 'uploaded';
  item.stageText = res.deduped ? '上传完成（服务端已有相同文件）' : '上传完成';
  render();
}

function uploadFile(item, md5) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;                       // 移除该行时可中断上传
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.name));
    xhr.setRequestHeader('X-File-MD5', md5);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      item.uploadPct = Math.round((e.loaded / e.total) * 100);
      item.stageText = `上传中 ${item.uploadPct}%`;
      render();
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* 忽略 */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.file) resolve(data);
      else reject(new Error(data.error || `上传失败 HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.send(item.file);
  });
}

/** 上传都落定后建批次；服务端按内容去重，内容相同的行共享同一任务 */
async function ensureBatch() {
  if (state.syncing) return;
  if (state.items.some((it) => ['queued', 'hashing', 'uploading'].includes(it.phase))) return;
  const ready = state.items.filter((it) => it.fileId && !it.added);
  if (!ready.length) return;
  const durations = {};
  ready.forEach((it) => { if (it.durationSec) durations[it.fileId] = it.durationSec; });
  const fileIds = ready.map((it) => it.fileId);   // 保留每一行（相同内容服务端标记为复用）
  state.syncing = true;
  try {
    const data = state.batchId
      // 已有批次 → 追加（分批添加）
      ? await jsonApi(`/api/batches/${state.batchId}/items`, { method: 'POST', body: JSON.stringify({ fileIds, durations, erasePreset: el.erasePreset?.value || 'standard' }) })
      : await jsonApi('/api/batches', { method: 'POST', body: JSON.stringify({ fileIds, operation: 'erase-subtitle', durations, erasePreset: el.erasePreset?.value || 'standard' }) });
    if (!state.batchId) {
      state.batchId = data.batch.id;
      try { localStorage.setItem(STORE_KEY, state.batchId); } catch { /* 忽略 */ }
    }
    ready.forEach((it) => { it.added = true; });   // 已并入批次 → 之后由服务端行渲染
    applyBatch(data);
    render();
    startPolling();
  } catch (err) {
    setNotice(`无法加入任务批次：${err.message}`);
  } finally {
    state.syncing = false;
  }
}

/* ============================================================================
 * 批次轮询（一次请求拿整批）
 * ========================================================================== */
function applyBatch(data) {
  state.batch = data.batch;
  state.rows = data.items || [];
  // 用最新的可用磁盘刷新本地快照，磁盘提示才能实时更新
  if (data.batch?.disk?.free != null && state.config?.disk) state.config.disk.free = data.batch.disk.free;
  el.batchCard.hidden = false;
}
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(poll, 1500);
  poll();
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}
async function poll() {
  if (!state.batchId) return;
  try {
    const data = await jsonApi(`/api/batches/${state.batchId}`, { timeoutMs: 8000 });
    applyBatch(data);
    render();
    if (!(state.rows || []).some((r) => r.status === 'queued' || r.status === 'running')) stopPolling();
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') return;
    if (err.status === 404) {
      stopPolling();
      clearSaved();
      state.batchId = null;
      state.batch = null;
      state.rows = [];
      setNotice('这批任务记录已过期并被清理，请重新选择文件。');
      render();
    }
    // 其它错误（网络抖动）保持轮询
  }
}

/* ============================================================================
 * 渲染
 * ========================================================================== */
function localRow(it, i) {
  return {
    key: it.key,
    index: i + 1,
    fileName: it.name,
    sizeText: fmtBytes(it.size),
    durationSec: it.durationSec,
    status: it.phase === 'hashing' ? 'hashing'
      : ['queued', 'uploading'].includes(it.phase) ? 'uploading'
      : it.phase === 'uploaded' ? 'idle' : 'upload-failed',
    progress: it.phase === 'uploading' ? it.uploadPct : it.phase === 'hashing' ? it.hashPct : 0,
    stage: it.stageText || '',
    error: it.error || null,
    fileId: it.fileId,
    taskId: null,
    shared: false,
    result: null,
    downloadUrl: null,
    previewUrl: null,
    sourceExpiresAt: null,
    local: true,
  };
}

/**
 * 列表行 = 服务端批次里的行 + 还没并入批次的本地上传行。
 * 「分批添加」时新选的文件在**上传阶段就立刻可见**（上传完自动并入批次）。
 */
function viewRows() {
  const serverRows = state.rows.map((r, i) => ({ ...r, key: `${r.fileId}:${i}`, index: i + 1 }));
  const pending = state.items.filter((it) => !it.added);
  if (!serverRows.length) return pending.map((it, i) => localRow(it, i));
  return [...serverRows, ...pending.map((it, i) => localRow(it, serverRows.length + i))];
}

const STATUS_LABEL = {
  idle: { text: '待开始', cls: '' },
  hashing: { text: '校验内容（MD5）', cls: 'pill-wait' },
  uploading: { text: '上传中', cls: 'pill-wait' },
  'upload-failed': { text: '上传失败', cls: 'pill-bad' },
  queued: { text: '排队中（云端）', cls: 'pill-wait' },
  running: { text: '处理中', cls: 'pill-run' },
  done: { text: '已完成', cls: 'pill-ok' },
  succeeded: { text: '已完成', cls: 'pill-ok' },
  failed: { text: '失败', cls: 'pill-bad' },
  canceled: { text: '已取消', cls: 'pill-skip' },
  expired: { text: '已过期', cls: 'pill-skip' },
};

/** 丢掉已经不存在的勾选（比如某行被移除、或本地上传行并入了批次） */
function pruneSelection(rows) {
  const keys = new Set(rows.map((r) => r.key));
  for (const k of [...state.selected]) if (!keys.has(k)) state.selected.delete(k);
}

let renderQueued = false;
/** 合并高频 render：同一帧内多次调用只真正渲染一次（30 行 + 频繁进度时很关键） */
function render() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => { renderQueued = false; renderNow(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/**
 * 结构签名：行集合 / 每行状态 / 展开的行。
 * 只有"结构变了"才整块重建；否则只原地改百分比与文字 —— 因为重建会让
 * 转圈动画每秒从 0 重播（看着像闪烁）、也会让预览里的 video 重新加载。
 */
function structureSig(rows) {
  return rows.map((r) => `${r.key}|${r.status}|${r.shared ? 1 : 0}${r.reused ? 1 : 0}${r.attached ? 1 : 0}`).join('~')
    + '##' + (state.openKey || '');
}
let lastSig = '';

/** 原地更新（结构未变时）：只改文字/百分比/进度条宽度 */
function patchRows(rows) {
  const nodes = [...el.list.querySelectorAll('.row')];
  rows.forEach((r, i) => {
    const node = nodes[i];
    if (!node || node.dataset.key !== r.key) return;
    const label = STATUS_LABEL[r.status] || { text: r.status, cls: '' };
    const showPct = r.status === 'running' || r.status === 'uploading' || r.status === 'hashing';
    const pill = node.querySelector('.pill');
    if (pill) pill.textContent = `${label.text}${showPct ? ` ${r.progress}%` : ''}`;
    const bar = node.querySelector('.row-sub .bar > span');
    if (bar) bar.style.width = `${r.progress}%`;
    const stage = node.querySelector('.row-sub .stage');
    if (stage && r.stage) stage.textContent = r.stage;
    // 勾选状态也原地同步（点「全选」时每行的勾选框要跟着变）
    const checked = state.selected.has(r.key);
    const box = node.querySelector('.check input');
    if (box && box.checked !== checked) box.checked = checked;
    node.classList.toggle('is-checked', checked);
  });

  // 展开的预览面板：只更新目标侧的百分比/进度条/阶段与已用时间，不重建节点
  const r = rows.find((x) => x.key === state.openKey);
  const panel = el.list.querySelector('.panel');
  if (r && panel) {
    const t = panel.querySelector('.preview-item:last-child .t');
    if (t && (r.status === 'running' || r.status === 'queued')) {
      t.textContent = r.status === 'queued' ? '已提交，云端排队中' : `正在去字幕 ${r.progress}%`;
    }
    const tbar = panel.querySelector('.preview-item:last-child .tbar > span');
    if (tbar && r.status === 'running') tbar.style.width = `${r.progress}%`;
    const hs = panel.querySelectorAll('.preview-item:last-child .h');
    if (hs[0] && r.stage) hs[0].textContent = r.stage;
    if (hs[1]) {
      const lines = [];
      if (r.elapsedSeconds) lines.push(`已用 ${fmtClock(r.elapsedSeconds)}`);
      if (r.etaSeconds) lines.push(`预计还需约 ${fmtClock(r.etaSeconds)}`);
      hs[1].textContent = lines.join(' · ');
    }
  }
}

function renderNow() {
  const rows = viewRows();
  const sig = structureSig(rows);
  if (sig === lastSig) {
    pruneSelection(rows);
    patchRows(rows);
    renderSummary(rows);
    renderDiskWarn();
    renderBatchButtons(rows);
    el.quota.textContent = `${rows.length} / ${state.config?.maxBatchSize || 30}`;
    return;
  }
  lastSig = sig;
  el.list.innerHTML = '';
  rows.forEach((r) => {
    el.list.appendChild(rowNode(r));
    if (state.openKey === r.key) el.list.appendChild(panelNode(r));
  });
  pruneSelection(rows);
  renderSummary(rows);
  renderDiskWarn();
  renderBatchButtons(rows);
  el.quota.textContent = `${rows.length} / ${state.config?.maxBatchSize || 30}`;
  // 关键：只要有行就显示这张卡片。
  // 上传阶段（还没建批次）也要让用户立刻看到每一行的「计算 MD5 / 上传中 x%」，
  // 否则选完文件后界面会有几十秒到几分钟毫无反应。
  el.batchCard.hidden = rows.length === 0;
}

function rowNode(r) {
  const label = STATUS_LABEL[r.status] || { text: r.status, cls: '' };
  // 处理中的进度不放在行内（去目标视频面板里显示），行内进度条只用于上传/校验
  const showRowBar = r.status === 'uploading' || r.status === 'hashing';
  const showPct = showRowBar || r.status === 'running';
  const done = r.status === 'done' || r.status === 'succeeded';
  const checked = state.selected.has(r.key);
  const node = document.createElement('div');
  node.className = 'row' + (state.openKey === r.key ? ' is-open' : '') + (checked ? ' is-checked' : '');
  node.dataset.key = r.key;
  node.innerHTML = `
    <label class="check"><input type="checkbox"${checked ? ' checked' : ''} /></label>
    <div class="idx">${String(r.index).padStart(2, '0')}</div>
    <div class="thumb ${done ? 'done' : r.shared ? 'skip' : ''}">${r.shared ? '秒传' : r.durationSec ? `${r.durationSec} 秒` : '—'}</div>
    <div class="row-main">
      <div class="row-title">
        <span class="name">${escapeHtml(r.fileName)}</span>
        <span class="meta">${r.sizeText}${r.durationSec ? ` · ${r.durationSec} 秒` : ''}</span>
      </div>
      <div class="row-sub">
        <span class="pill ${label.cls}">${label.text}${showPct ? ` ${r.progress}%` : ''}</span>
        ${showRowBar ? `<div class="bar"><span style="width:${r.progress}%"></span></div>` : ''}
        ${r.stage ? `<span class="stage">${escapeHtml(r.stage)}</span>` : ''}
        ${r.error ? `<span class="stage">${escapeHtml(r.error)}</span>` : ''}
        ${r.reused ? '<span class="stage">复用服务器上已去字幕的产物（未重复提交接口）</span>' : ''}
        ${r.attached ? '<span class="stage">与正在处理中的同名内容合并（未重复提交）</span>' : ''}
        ${r.shared && !r.reused && !r.attached ? '<span class="stage">与同一批里的相同内容共用结果（秒传）</span>' : ''}
      </div>
    </div>
    <div class="row-actions"></div>`;

  const actions = node.querySelector('.row-actions');
  const mk = (text, cls, enabled, fn) => {
    const b = document.createElement('button');
    b.className = `btn ${cls} btn-sm`;
    b.textContent = text;
    b.disabled = !enabled;
    b.onclick = fn;
    actions.appendChild(b);
  };
  const box = node.querySelector('.check input');
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(r.key); else state.selected.delete(r.key);
    render();
  });
  node.addEventListener('click', (e) => {          // 点行空白处也能勾选
    if (e.target.closest('.btn') || e.target.closest('.check') || e.target.closest('video') || e.target.closest('a')) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
  });
  mk(state.openKey === r.key ? '预览 ▾' : '预览 ▸', 'btn-ghost btn-preview', true, () => togglePreview(r.key));
  const act = rowAction(r);
  mk(act.text, act.cls, act.enabled, act.fn);
  // 移除任务：处理中不能移除；未开始 / 已完成 / 失败 都可以
  const canRemove = !['queued', 'running'].includes(r.status);
  mk('移除任务', 'btn-ghost btn-stop', canRemove, () => removeRow(r));
  return node;
}

/** 行内共享按钮三态：开始任务 / 停止任务 / 下载视频 */
function rowAction(r) {
  if (r.status === 'uploading' || r.status === 'upload-failed' || r.status === 'expired') {
    return { text: '开始任务', cls: 'btn-ghost', enabled: false, fn: () => {} };
  }
  if (r.status === 'queued' || r.status === 'running') {
    return { text: '停止任务', cls: 'btn-ghost btn-stop', enabled: true, fn: () => stopTask(r) };
  }
  if (r.status === 'done' || r.status === 'succeeded') {
    const busy = state.downloading.has(r.taskId);
    return { text: busy ? '下载中…' : '下载视频', cls: 'btn-ghost', enabled: !busy, fn: () => downloadRow(r) };
  }
  const ready = state.config?.eraseReady !== false && !diskState().low;
  return { text: '开始任务', cls: 'btn-ghost', enabled: ready && Boolean(r.taskId), fn: () => startTask(r) };
}

/** 展开的对比预览：源视频（未上传完显示"正在上传……"）+ 目标视频（随状态变化） */
function panelNode(r) {
  const wrap = document.createElement('div');
  wrap.className = 'panel';
  const done = r.status === 'done' || r.status === 'succeeded';
  const uploading = r.status === 'uploading' || r.status === 'upload-failed';
  // 统一走服务器副本（不再用云端直连地址）
  const targetSrc = r.previewUrl || '';

  const srcBody = uploading
    ? `<div class="state"><div class="glyph ${r.status === 'upload-failed' ? 'bad' : 'spin'}"></div>
         <div class="t">${r.status === 'upload-failed' ? '上传失败' : '正在上传……'}</div>
         <div class="h">${escapeHtml(r.fileName)} · ${r.sizeText}${r.status === 'uploading' ? ` · 已上传 ${r.progress}%` : ''}</div></div>`
    : r.fileId
      ? (UNPLAYABLE_EXT.has(extOf(r.fileName))
          ? previewFallback('src', r)
          : `<video class="panel-video" controls preload="metadata" playsinline src="/f/${r.fileId}"></video>`)
      : '<div class="state"><div class="t">等待上传</div></div>';

  const tgtBody = done
    ? `<video class="panel-video" controls preload="metadata" playsinline src="${targetSrc}"></video>`
    : r.status === 'failed'
      ? `<div class="state"><div class="glyph bad"></div><div class="t">处理失败</div><div class="h">${escapeHtml(r.error || '接口返回失败')}</div></div>`
      : (r.status === 'queued' || r.status === 'running')
        ? (() => {
             // 处理中的进度统一显示在**目标视频**这一侧：百分比 + 进度条 + 阶段 + 已用/剩余
             const lines = [];
             if (r.elapsedSeconds) lines.push(`已用 ${fmtClock(r.elapsedSeconds)}`);
             if (r.etaSeconds) lines.push(`预计还需约 ${fmtClock(r.etaSeconds)}`);
             return `<div class="state">
               <div class="glyph spin"></div>
               <div class="t">${r.status === 'queued' ? '已提交，云端排队中' : `正在去字幕 ${r.progress}%`}</div>
               <div class="tbar"><span style="width:${r.status === 'queued' ? 0 : r.progress}%"></span></div>
               <div class="h">${escapeHtml(r.stage || '云端正在逐帧擦除字幕')}</div>
               ${lines.length ? `<div class="h">${lines.join(' · ')}</div>` : ''}
             </div>`;
           })()
        : uploading
          ? '<div class="state"><div class="t">等待上传完成</div><div class="h">源视频上传完成后即可开始去字幕</div></div>'
          : r.status === 'canceled'
            ? `<div class="state"><div class="t">已取消</div>
                 <div class="h">${r.remoteCancel?.ok
                   ? '云端已接受终止请求'
                   : '去字幕接口未提供取消能力，已停止本地跟踪（不再轮询、不再下载产物）'}</div>
                 <div class="h">点这一行的「开始任务」可重新处理</div></div>`
            : '<div class="state"><div class="t">等待处理</div><div class="h">点这一行的「开始任务」，或勾选后用「批量开始」</div></div>';

  const srcExpiry = r.sourceExpiresAt
    ? new Date(r.sourceExpiresAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
  wrap.innerHTML = `
    <div class="panel-head">
      <span class="panel-title">对比预览 · <b>${escapeHtml(r.fileName)}</b></span>
      <button class="btn btn-ghost btn-sm" type="button">收起预览</button>
    </div>
    <div class="preview-pair">
      <div class="preview-item">
        <div class="panel-cap">源视频</div>
        <figure class="preview">${srcBody}</figure>
        <div class="expiry-row"><span class="expiry-chip">源文件有效期至 ${srcExpiry}</span></div>
      </div>
      <div class="preview-item">
        <div class="panel-cap">目标视频</div>
        <figure class="preview">${tgtBody}</figure>
        <div class="expiry-row">${done ? `<span class="expiry-chip">产物与源文件一同在 ${state.config?.uploadTtlHours ?? 12} 小时后清理</span>` : ''}</div>
      </div>
    </div>`;
  wrap.querySelector('.panel-head .btn').onclick = () => togglePreview(r.key);
  // 播放失败（编码不支持、链接过期、文件被清）→ 换成说明 + 下载入口，不留死播放器
  wrap.querySelectorAll('video').forEach((v) => {
    const swap = () => {
      const fig = v.closest('.preview');
      const isSrc = Boolean(v.closest('.preview-item:first-child'));
      if (fig) fig.innerHTML = previewFallback(isSrc ? 'src' : 'tgt', r);
    };
    v.addEventListener('error', swap, { once: true });
    if (v.error) swap();
  });
  return wrap;
}

function renderSummary(rows) {
  const n = (s) => rows.filter((r) => r.status === s).length;
  const done = n('done') + n('succeeded');
  const running = n('running');
  const uploading = n('uploading');
  const queued = n('queued');
  const failed = n('failed') + n('upload-failed');
  const idle = n('idle') + n('canceled');
  const total = rows.length;
  const sc = state.batch?.counts;

  el.bigDone.textContent = `已完成 ${sc ? sc.done : done} / ${total}`;
  el.cDone.textContent = sc ? sc.done : done;
  el.cRun.textContent = sc ? sc.running : running;
  el.cUp.textContent = uploading;
  el.cQueued.textContent = sc ? sc.queued : queued;
  el.cIdle.textContent = sc ? sc.idle + sc.canceled : idle;
  el.cBad.textContent = sc ? sc.failed : failed;

  const pct = sc?.progressPct ?? (total ? Math.round(((done + running * 0.5) / total) * 100) : 0);
  el.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;

  const active = sc ? sc.running + sc.queued : running + queued;
  const etaSec = state.batch?.etaSeconds || 0;
  el.eta.textContent = active
    ? (etaSec ? `预计剩余约 ${fmtClock(etaSec)}` : '正在估算剩余时间…')
    : failed ? `${failed} 项失败，可单独重试`
    : uploading ? `${uploading} 个文件上传中…`
    : total && (sc ? sc.done === total : done === total) ? '全部完成'
    : `${idle} 项待开始`;

  el.batchPill.textContent = (running || queued) ? `处理中 ${running + queued}`
    : uploading ? `上传中 ${uploading}`
    : total && done === total ? '全部完成'
    : failed ? '有失败项' : '待开始';
  el.batchPill.className = `pill ${(running || queued) ? 'pill-run' : uploading ? 'pill-wait' : failed ? 'pill-bad' : (total && done === total) ? 'pill-ok' : ''}`;

  const files = sc?.total ?? total;
  const estBytes = rows.reduce((a, r) => a + (Number(r.size) || 0), 0) * (state.config?.disk?.outputFactor || 1.5);
  const free = state.batch?.disk?.free ?? state.config?.disk?.free;
  el.batchSub.textContent = !state.batchId && uploading
    ? `${uploading} 个文件正在上传…（上传完成后自动建批次）`
    : `共 ${files} 个文件${estBytes ? ` · 预计产物占用 ${fmtBytes(estBytes)}` : ''}`;
  el.diskInfo.innerHTML = `预计占用 <b>${fmtBytes(estBytes)}</b> / 可用 <b>${free ? fmtBytes(free) : '—'}</b>`;
}

/** 批量操作条：批量开始 / 批量取消（只作用于勾选的行） */
/** 勾选的行（按当前列表顺序） */
function selectedRows(rows) {
  return rows.filter((r) => state.selected.has(r.key));
}
const CAN_BATCH_START = ['idle', 'failed', 'canceled'];
const CAN_BATCH_CANCEL = ['queued', 'running'];

/**
 * 批量操作条：两个独立按钮，只作用于**勾选过的任务**。
 * 不随单个任务的状态变化而改名 —— 单个任务用行内那个按钮控制。
 */
function renderBatchButtons(rows) {
  const picked = selectedRows(rows);
  const startable = picked.filter((r) => CAN_BATCH_START.includes(r.status) && r.taskId);
  const cancellable = picked.filter((r) => CAN_BATCH_CANCEL.includes(r.status) && r.taskId);
  const ready = state.config?.eraseReady !== false;

  const deletable = picked.filter((r) => !['queued', 'running'].includes(r.status) && (r.fileId || r.taskId));
  const blocked = picked.filter((r) => ['queued', 'running'].includes(r.status)).length;
  el.batchDelete.disabled = deletable.length === 0 || blocked > 0;
  el.batchDelete.textContent = deletable.length && !blocked ? `批量删除（${deletable.length}）` : '批量删除';
  el.batchDelete.title = blocked
    ? `勾选里有 ${blocked} 个正在处理，请先「批量取消」再删除`
    : '删除勾选的任务，并清理服务器上的源文件、产物与 MD5 索引';

  el.batchStart.disabled = !ready || startable.length === 0 || diskState().low;
  el.batchStart.title = diskState().low ? '磁盘空间不足，已暂停接收新任务' : '';
  el.batchCancel.disabled = cancellable.length === 0;
  el.batchStart.textContent = startable.length ? `批量开始（${startable.length}）` : '批量开始';
  el.batchCancel.textContent = cancellable.length ? `批量取消（${cancellable.length}）` : '批量取消';

  // 全选框与计数
  const checkable = rows.filter((r) => r.fileId || r.taskId);
  el.checkAll.checked = checkable.length > 0 && picked.length === checkable.length;
  el.checkAll.indeterminate = picked.length > 0 && picked.length < checkable.length;
  el.selNote.textContent = picked.length
    ? `已勾选 ${picked.length} 项：可开始 ${startable.length} · 可取消 ${cancellable.length}`
    : '未勾选任务（勾选后用「批量开始 / 批量取消」）';
}

/** 批量开始 / 批量取消：只提交勾选的行号（服务端也按行号处理） */
async function batchAction(kind) {
  const rows = viewRows();
  const picked = selectedRows(rows).filter((r) => r.taskId && !r.local);
  // 三种操作的行状态条件不同：开始=待开始/失败/已取消；取消=排队/处理中；删除=所有不在处理中的行
  const want = kind === 'start' ? CAN_BATCH_START : kind === 'cancel' ? CAN_BATCH_CANCEL : null;
  const indexes = picked
    .filter((r) => (want ? want.includes(r.status) : !['queued', 'running'].includes(r.status)))
    .map((r) => r.index - 1);
  if (!indexes.length) return;
  const btn = kind === 'start' ? el.batchStart : el.batchCancel;
  if (!markBusy(btn, kind === 'start' ? '正在开始…' : '正在取消…')) return;   // 防连点/防并发
  try {
    if (kind === 'start') {
      const res = await jsonApi(`/api/batches/${state.batchId}/start`, {
        method: 'POST', body: JSON.stringify({ indexes }),
      });
      toast(`已提交 ${res.started ?? indexes.length} 个任务，云端并行处理`);
    } else if (kind === 'delete') {
      const res = await jsonApi(`/api/batches/${state.batchId}/items`, { method: 'DELETE', body: JSON.stringify({ indexes }) });
      const parts = [];
      if (res.removedFiles) parts.push(`源文件 ${res.removedFiles} 个`);
      if (res.removedTasks) parts.push(`产物 ${res.removedTasks} 个`);
      if (res.removedMd5) parts.push(`MD5 索引 ${res.removedMd5} 条`);
      toast(`已批量删除 ${res.removed} 项${parts.length ? `：${parts.join(' + ')}` : ''}`
        + `${res.freedBytes ? `（释放 ${fmtBytes(res.freedBytes)}）` : ''}`
        + `${res.kept?.length ? `；${res.kept.length} 项仍被引用，已保留` : ''}`);
      applyBatch(res);
      if (!state.rows.length) {
        clearSaved();
        state.batchId = null;
        state.batch = null;
        state.items = [];
        el.batchCard.hidden = true;
      }
      render();
      return;
    } else {
      const res = await jsonApi(`/api/batches/${state.batchId}`, { method: 'DELETE', body: JSON.stringify({ indexes }) });
      toast(cancelToast(res.cancel, indexes.length));
    }
    startPolling();
  } catch (err) {
    toast(`${kind === 'start' ? '批量开始' : '批量取消'}失败：${err.message}`);
  } finally {
    clearBusy(btn);
    render();
  }
}

/* ============================================================================
 * 交互
 * ========================================================================== */
function togglePreview(key) {
  state.openKey = state.openKey === key ? null : key;   // 手风琴：同时只展开一条
  render();
}
async function startTask(r) {
  if (!r.taskId) return toast('该行还没有任务');
  const btn = rowActionButton(r, /开始任务|提交中/);
  if (!markBusy(btn, '提交中…')) return;          // 已经在提交 → 直接忽略
  try {
    try {
      await jsonApi(`/api/tasks/${r.taskId}/start`, { method: 'POST', body: JSON.stringify({}) });
    } catch (err) {
      toast(err.message || '开始失败');
      throw err;
    }
    toast(`已开始：${r.fileName}`);
    startPolling();
  } catch (err) {
    toast(`开始失败：${err.message}`);
    clearBusy(btn);
    render();
  }
}
/**
 * 取消后的提示要说实话：
 * 云端接受了取消请求 → 说"云端已终止"；官方没有取消接口 → 说"已停止本地跟踪"。
 */
function cancelToast(cancel, count) {
  const n = `已取消 ${count} 个任务`;
  if (cancel?.remoteOk) return `${n}：云端已接受终止请求`;
  if (cancel?.remoteFailed) return `${n}：去字幕接口未提供取消能力，已停止本地跟踪（不再轮询、不再下载产物）`;
  if (cancel?.background) return `${n}（本地已立即生效，云端终止请求已发出）`;
  return n;
}
async function stopTask(r) {
  if (!r.taskId) return;
  // 立刻给反馈：按钮变"取消中…"并禁用，避免重复点、也避免以为没生效
  const btn = rowActionButton(r, /停止任务|取消中/);
  if (!markBusy(btn, '取消中…')) return;          // 已经在取消 → 忽略重复点击
  try {
    const res = await jsonApi(`/api/tasks/${r.taskId}`, { method: 'DELETE' });
    toast(cancelToast(res.cancel, 1));
    startPolling();
    setTimeout(poll, 3000);   // 云端终止结果稍后才回来，再拉一次把说明补上
  } catch (err) {
    toast(err.code === 'TIMEOUT'
      ? '取消请求超时：服务器响应慢，页面仍可正常操作，请稍后重试'
      : `取消失败：${err.message}`);
    clearBusy(btn);
    render();
  }
}
el.batchStart.addEventListener('click', () => { if (!el.batchStart.disabled) batchAction('start'); });
el.batchCancel.addEventListener("click", () => { if (!el.batchCancel.disabled) batchAction("cancel"); });
el.batchDelete.addEventListener("click", () => { if (!el.batchDelete.disabled) batchAction("delete"); });
el.checkAll.addEventListener('change', () => {
  const rows = viewRows().filter((r) => r.fileId || r.taskId);
  if (el.checkAll.checked) rows.forEach((r) => state.selected.add(r.key));
  else rows.forEach((r) => state.selected.delete(r.key));
  render();
});

/* ---------------------------------------------------------------- 移除任务 */

/** 把服务端返回的清理结果说清楚：删了什么、释放多少、哪些因为被别人用着而保留 */
function purgeToast(res, fallbackName) {
  const parts = [];
  if (res.removedFile) parts.push('源文件');
  if (res.removedTask) parts.push('产物');
  if (res.removedMd5) parts.push('MD5 索引');
  const size = res.freedBytes ? `（释放 ${fmtBytes(res.freedBytes)}）` : '';
  if (parts.length) return `已移除并清理：${parts.join(' + ')}${size}`;
  const kept = [res.keptFile, res.keptTask].filter(Boolean).join('；');
  return kept ? `已移除该行（${kept}，暂未删除）` : `已移除：${fallbackName}`;
}
async function removeRow(r) {
  // 批次还没建立（还在上传阶段）→ 纯本地移除，并中断进行中的上传
  if (r.local || !state.batchId) {
    const it = state.items.find((x) => x.key === r.key);
    // 已经上传到服务器的源文件也要一起清掉（源文件 + MD5 索引 + 内容索引）
    let purged = null;
    if (it?.fileId) {
      try { purged = await jsonApi(`/api/files/${it.fileId}`, { method: 'DELETE' }); }
      catch { /* 已被其它行引用或已清理：忽略，不影响本地移除 */ }
    }
    if (it?.xhr) { try { it.xhr.abort(); } catch { /* 忽略 */ } }
    state.items = state.items.filter((x) => x.key !== r.key);
    if (state.openKey === r.key) state.openKey = null;
    render();
    toast(purged ? purgeToast(purged, r.fileName) : `已移除：${r.fileName}`);
    return;
  }
  const btn = rowActionButton(r, /移除任务|移除中/);
  // 关键：移除是按"行号"删的，连点第二次会删到下一行 → 必须挡住重复点击
  if (!markBusy(btn, '移除中…')) return;
  try {
    const res = await jsonApi(`/api/batches/${state.batchId}/items/${r.index - 1}`, { method: 'DELETE' });
    applyBatch(res);
    if (state.openKey === r.key) state.openKey = null;
    if (!state.rows.length) {            // 整批都被移除了 → 回到纯上传状态
      clearSaved();
      state.batchId = null;
      state.batch = null;
      state.items = [];
      el.batchCard.hidden = true;
    }
    render();
    toast(purgeToast(res, r.fileName));
  } catch (err) {
    toast(`移除失败：${err.message}`);
    clearBusy(btn);
    render();
  }
}

/* ---------------------------------------------------------------- 逐任务下载 */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function downloadRow(r) {
  const name = r.result?.name && /-无字幕\./.test(r.result.name)
    ? r.result.name
    : `${String(r.fileName).replace(/\.[^.]+$/, '')}-无字幕.mp4`;
  if (!r.taskId) return toast('这一行还没有可下载的产物');

  // 同源地址：服务端带头流式返回（浏览器下载管理器接管：立即开始、有原生进度、不占内存）
  const localUrl = `/api/download/${r.taskId}`;
  const btn = rowDownloadButton(r);
  // 同一行在 90 秒内只允许下一次，避免连点触发多个重复下载
  if (state.downloading.has(r.taskId)) return toast('这一行已经在下载了');
  state.downloading.add(r.taskId);
  setTimeout(() => { state.downloading.delete(r.taskId); render(); }, 90000);
  const setBusy = (busy) => { if (btn) { btn.disabled = busy; btn.textContent = busy ? '下载中…' : '下载视频'; } };

  // 产物不在服务器（KEEP_ARTIFACT=false）：/api/download 会 302 到云端，
  // 这里用 fetch 跟随后流式写入内存再保存 —— 数据由浏览器直连云端，不占服务器带宽。
  setBusy(true);
  try {
    const res = await fetch(localUrl, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body?.getReader?.();
    let got = 0;
    const chunks = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (btn && total) btn.textContent = `下载中 ${Math.min(99, Math.round((got / total) * 100))}%`;
      }
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()));
    }
    const blob = new Blob(chunks, { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`已保存 ${name}（${fmtBytes(blob.size)}）`);
  } catch (err) {
    toast(`下载失败：${err.message}；可在预览里右键「存储视频为…」直接保存`);
  } finally {
    setBusy(false);
  }
}

/** 找到某一行上的「下载视频」按钮（用于显示下载中状态） */
/** 浏览器无法内联播放的容器：直接给兜底提示，而不是塞一个放不出来的播放器 */
const UNPLAYABLE_EXT = new Set(['.mkv', '.avi', '.flv', '.wmv', '.ts', '.mpeg', '.mpg', '.vob', '.rmvb', '.3gp', '.m2ts']);
const extOf = (name) => `.${String(name || '').split('.').pop().toLowerCase()}`;

/** 源/目标视频放不出来时的兜底面板（含下载入口） */
function previewFallback(kind, r) {
  if (kind === 'src') {
    const ext = extOf(r.fileName);
    const why = UNPLAYABLE_EXT.has(ext)
      ? `浏览器不支持 ${escapeHtml(ext)} 格式的内联播放`
      : '该视频的编码浏览器无法解码（或文件已过期）';
    return `<div class="state">
      <div class="t">浏览器无法直接预览这个视频</div>
      <div class="h">${why}；不影响去字幕处理，处理后可以下载产物</div>
      ${r.fileId ? `<a class="btn btn-ghost btn-sm" href="/f/${r.fileId}?dl=1" download>下载源文件</a>` : ''}
    </div>`;
  }
  return `<div class="state">
    <div class="t">产物暂时无法播放</div>
    <div class="h">${r.productRemote && r.productExpiresAt
      ? `产物在云端保存，有效期至 ${new Date(r.productExpiresAt).toLocaleString('zh-CN', { hour12: false })}`
      : '服务器上的产物可能已被清理（12 小时），或浏览器不支持该编码'}</div>
    ${r.downloadUrl ? `<a class="btn btn-ghost btn-sm" href="${r.downloadUrl}">下载视频</a>` : ''}
  </div>`;
}

/** 行内按钮：按文字找（用于"取消中…"这类即时反馈） */
function rowActionButton(r, re) {
  const node = el.list.querySelectorAll('.row')[r.index - 1];
  if (!node) return null;
  return [...node.querySelectorAll('.row-actions .btn')].find((b) => re.test(b.textContent)) || null;
}

function rowDownloadButton(r) {
  const nodes = [...el.list.querySelectorAll('.row')];
  const node = nodes[r.index - 1];
  if (!node) return null;
  return [...node.querySelectorAll('.row-actions .btn')].find((b) => /下载视频|下载中/.test(b.textContent)) || null;
}

/* ---------------------------------------------------------------- 刷新恢复 */
function clearSaved() { try { localStorage.removeItem(STORE_KEY); } catch { /* 忽略 */ } }
async function restore() {
  let batchId = null;
  try { batchId = localStorage.getItem(STORE_KEY); } catch { /* 忽略 */ }
  if (!batchId) return;
  try {
    const data = await jsonApi(`/api/batches/${batchId}`);
    state.batchId = batchId;
    applyBatch(data);
    render();
    if ((data.items || []).some((r) => r.status === 'queued' || r.status === 'running')) startPolling();
    toast('已恢复上次的任务批次');
  } catch {
    clearSaved();
  }
}

/* ---------------------------------------------------------------- 事件 */
el.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
    const phone = el.phoneInput.value.trim();
    const password = el.passwordInput.value;
  if (!phone || !password) return;
  if (loginPending) return;              // 回车连按 / 连点 → 只发一次
  markBusy(el.loginBtn, '正在验证…');
  try {
    await login(phone, password);
    el.passwordInput.value = '';
    showApp();
  renderCredits();
    await init();
      renderCredits();
  } catch (err) {
    el.authError.textContent = err.message || '登录失败';
    el.authError.hidden = false;
  } finally {
    clearBusy(el.loginBtn);
  }
});
  el.registerBtn.addEventListener('click', async () => {
    const phone = el.phoneInput.value.trim();
    const password = el.passwordInput.value;
    if (!phone || !password) {
      el.authError.textContent = '请先填写手机号和密码';
      el.authError.hidden = false;
      return;
    }
    if (loginPending) return;
    markBusy(el.registerBtn, '正在注册…');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      sessionEndsAt = Date.parse(data.expiresAt);
      state.session = data;
      el.passwordInput.value = '';
      el.authError.hidden = true;
      showApp();
      await init();
      renderCredits();
      toast('注册成功，已自动登录');
    } catch (err) {
      el.authError.textContent = err.message || '注册失败';
      el.authError.hidden = false;
    } finally {
      clearBusy(el.registerBtn);
    }
  });

  /** 页头积分徽标（点击输入卡密充值） */
  function renderCredits() {
    const u = state.session?.user;
    if (!u) return;
    let badge = document.getElementById('creditsBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'creditsBadge';
      badge.className = 'credits-badge';
      el.logoutBtn.parentNode.insertBefore(badge, el.logoutBtn);
      badge.addEventListener('click', async () => {
        const code = window.prompt('输入卡密（形如 WM-XXXX-XXXX-XXXX-XXXX）');
        if (!code) return;
        try {
          const r = await jsonApi('/api/credits/redeem', { method: 'POST', body: JSON.stringify({ code }) });
          state.session.user = r.user;
          renderCredits();
          toast(`充值成功 +${r.credits} 积分，余额 ${r.balance}`);
        } catch (err) { toast(`充值失败：${err.message}`); }
      });
    }
    badge.textContent = `积分 ${u.credits} · 充值`;
    badge.title = '点击输入卡密充值';
  }


el.logoutBtn.addEventListener('click', async () => {
  if (!markBusy(el.logoutBtn, '正在退出…')) return;
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* 忽略 */ }
  sessionEndsAt = null;
  state.session = { authenticated: false };
  showLogin();
});

let pickGuard = 0;
// 切换处理模式（标准 / 全屏）：只更新还没开始的任务，进行中的不受影响
el.erasePreset?.addEventListener('change', async () => {
  if (!state.batchId) return;
  const preset = el.erasePreset.value;
  const label = el.erasePreset.selectedOptions[0].textContent;
  try {
    const res = await jsonApi(`/api/batches/${state.batchId}`, {
      method: 'PATCH', body: JSON.stringify({ erasePreset: preset }),
    });
    toast(`处理模式已改为「${label}」：更新 ${res.updated} 个待开始任务${res.running ? `，${res.running} 个进行中不变` : ''}`);
    applyBatch(res);
    render();
  } catch (err) { toast(`修改失败：${err.message}`); }
});

el.dropzone.addEventListener('click', () => {
  const now = Date.now();
  if (now - pickGuard < 600) return;     // 连点不要弹出两次选择框
  pickGuard = now;
  el.fileInput.click();
});
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', () => { acceptFiles(el.fileInput.files); el.fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add('is-drag'); }));
['dragleave', 'drop'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove('is-drag'); }));
el.dropzone.addEventListener('drop', (e) => acceptFiles(e.dataTransfer?.files));
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) acceptFiles(files);
});

bootstrap();
