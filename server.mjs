#!/usr/bin/env node
/**
 * ClipFlow 服务端（零依赖，仅 Node.js 内置模块）
 * 全自动视频去字幕站点：上传 → 云端/本地去字幕 → 预览与下载
 *
 * 职责：
 *   1. Token 登录（会话 Cookie，当天 23:59:59 失效，第二天需重新登录）
 *   2. 接收视频上传（流式落盘、大小限制、MD5/SHA-256 校验、MD5 秒传去重）
 *   3. 为每个文件生成唯一 ID（/f/<id>）与 MD5 寻址（/f/<md5>）
 *   4. 去字幕接口 POST /api/files/:id/process -> 返回 taskId；GET /api/tasks/:taskId 轮询
 *   5. 源文件与产物都可预览，产物可下载 GET /api/download/:taskId
 *   6. 源文件 12 小时后过期：删除文件 + 移除 MD5 索引 + 清理派生产物
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { normalizePhone, findUserByPhone, createUser, checkPassword, publicUser, createUserSession, chargeSeconds, refundSeconds, createCodes, redeemCode, ensureAdmin } from './accounts.mjs';
import { fileURLToPath } from 'node:url';
import {
  OPERATIONS,
  DEFAULT_OPERATION,
  STAGES,
  runPipeline,
  cancelRemoteTask,
  eraseApiConfig,
  writePoster,
  formatBytes,
} from './pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 构建号：部署时由 install.sh 写入 BUILD 文件（精确到分钟），例如 build202610141950。
 * 优先环境变量 BUILD_ID，其次 BUILD 文件，本地开发没有该文件时退回本次启动时间。
 */
function resolveBuildId() {
  const stamp = (d) => `build${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  if (process.env.BUILD_ID) return String(process.env.BUILD_ID).trim();
  try {
    const fromFile = fs.readFileSync(path.join(__dirname, 'BUILD'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* 本地开发没有 BUILD 文件，属正常 */ }
  return stamp(new Date());
}
const BUILD_ID = resolveBuildId();
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 ** 2); // 单文件上限 100MB
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
/**
 * 批量任务编排：把"跑一个任务"拆成两段，各用各的名额
 *   · 提交段（探测源文件 + 调接口提交）：很轻，可以同时提交很多 → SUBMIT_CONCURRENCY
 *   · 回传段（下载产物到本地）：很重（动辄上百 MB）→ FETCH_CONCURRENCY
 *   · 轮询段不占名额，只是一次很小的 GET
 * MAX_ACTIVE_TASKS 是"同时在场"的任务状态机数量（要有 10 个任务同时在跑就得 ≥10）。
 */
/**
 * 擦除区域（对应接口的 erase_ratio_location，相对比例 0~1 的对象数组）
 * 实测接口要求：数组元素必须是对象，字段为 top_left_x / top_left_y / bottom_right_x / bottom_right_y。
 * 「字幕在画面上半部」这类视频，默认区域往往会漏，选"全屏"或"上半部"就能覆盖到。
 */
const ERASE_REGIONS = {
  auto: null,     // 不传，交给接口自己判断（默认）
  full: [{ top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 1 }],
  top: [{ top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 0.5 }],
  middle: [{ top_left_x: 0, top_left_y: 0.25, bottom_right_x: 1, bottom_right_y: 0.75 }],
  bottom: [{ top_left_x: 0, top_left_y: 0.5, bottom_right_x: 1, bottom_right_y: 1 }],
};
/**
 * 两种处理模式（预设）——接口层直接支持 preset，也仍兼容细粒度参数
 *   standard   标准模式（默认）  ：只认常规字幕，快
 *   fullscreen 全屏模式（更彻底）：擦画面任何位置的文字与文字水印，耗时约 3 倍
 */
const ERASE_PRESETS = {
  standard: { mode: 'Subtitle', region: null, model: null },
  fullscreen: {
    mode: 'Text',
    region: [{ top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 1 }],
    model: 'v5.6',
  },
};
const ERASE_PRESET_KEYS = Object.keys(ERASE_PRESETS);
function resolveErasePreset(input) {
  const k = String(input || '').trim();
  return ERASE_PRESET_KEYS.includes(k) ? k : 'standard';
}
/** 把「预设 + 可选覆盖项」解析成真正要下发的三个参数 */
function applyErasePreset({ preset, region, mode, model } = {}) {
  const p = ERASE_PRESETS[resolveErasePreset(preset)];
  return {
    preset: resolveErasePreset(preset),
    mode: mode === undefined || mode === null ? p.mode : resolveEraseMode(mode),
    region: region === undefined ? p.region : resolveEraseRegion(region),
    model: model === undefined ? p.model : resolveModelVersion(model),
  };
}

/** 模型版本：v4（默认，快）/ v5 / v5.6（最新，效果最好） */
const MODEL_VERSIONS = ['v4', 'v5', 'v5.6'];
function resolveModelVersion(input) {
  const v = String(input || '').trim();
  return MODEL_VERSIONS.includes(v) ? v : null;
}

/** 擦除模式：Subtitle=只认常规字幕（快）；Text=擦画面里所有文字含 logo 水印（慢但彻底） */
const ERASE_MODES = ['Subtitle', 'Text'];
function resolveEraseMode(input) {
  return ERASE_MODES.includes(String(input || '').trim()) ? String(input).trim() : 'Subtitle';
}

/** 把前端的区域选项（或自定义数组）解析成接口参数；auto/非法一律 null */
function resolveEraseRegion(input) {
  if (Array.isArray(input)) {
    const ok = input.every((r) => r && ['top_left_x', 'top_left_y', 'bottom_right_x', 'bottom_right_y']
      .every((k) => typeof r[k] === 'number' && r[k] >= 0 && r[k] <= 1));
    return ok && input.length ? input : null;
  }
  const key = String(input || 'auto').trim();
  return Object.prototype.hasOwnProperty.call(ERASE_REGIONS, key) ? ERASE_REGIONS[key] : null;
}

/** 客户端同时上传几个文件（前端上传队列的并发度） */
const UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY || 3));
/** 一批最多多少个文件 */
const MAX_BATCH_SIZE = Math.max(1, Number(process.env.MAX_BATCH_SIZE || 30));
/** 产物约占源文件的倍数（实测 1.3~1.5），用于开始前的磁盘预判 */
const DISK_OUTPUT_FACTOR = Number(process.env.DISK_OUTPUT_FACTOR || 1.5);
/** 磁盘保护线：剩余空间低于这个值就**暂停接收新任务**（上传/建批次/开始任务全部拒绝） */
const DISK_MIN_FREE_BYTES = Math.max(0, Number(process.env.DISK_MIN_FREE_BYTES || 5 * 1024 ** 3));
/** 预留磁盘余量：低于这个值就拒绝新批次 */
const DISK_RESERVE_BYTES = Number(process.env.DISK_RESERVE_BYTES || 1024 ** 3);
const MAX_ACTIVE_TASKS = Math.max(1, Number(process.env.MAX_ACTIVE_TASKS || process.env.PROCESS_CONCURRENCY || 30));
const SUBMIT_CONCURRENCY = Math.max(1, Number(process.env.SUBMIT_CONCURRENCY || 10));
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.FETCH_CONCURRENCY || 2));

/** 极简并发池：限制同时执行的数量，其余排队（Promise 版信号量） */
function createPool(limit, name) {
  let active = 0;
  const waiters = [];
  const kick = () => {
    while (active < limit && waiters.length) {
      active += 1;
      const go = waiters.shift();
      go();
    }
  };
  return {
    name,
    get active() { return active; },
    get waiting() { return waiters.length; },
    run(fn) {
      return new Promise((resolve, reject) => {
        waiters.push(() => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => { active -= 1; kick(); });
        });
        kick();
      });
    },
  };
}
const submitPool = createPool(SUBMIT_CONCURRENCY, 'submit');
const fetchPool = createPool(FETCH_CONCURRENCY, 'fetch');
/** 云端"取消"尝试的并发池：官方没有取消接口、尝试必然失败，但仍要有上限，
 *  否则批量取消时堆一堆卡住的 socket（曾把浏览器 6 个连接占满 → 页面像卡死、连刷新都排队） */
const cancelPool = createPool(4, 'cancel');
/**
 * 去字幕接口不返回进度，用「原片时长 × RTF」预估总耗时来驱动进度条与剩余时间。
 * 官方给的 RTF（处理耗时/原片时长）区间很宽（5~30 倍），所以这里按历史任务自动学习：
 * 每完成一个任务就记录实测 RTF，之后取最近若干次的均值，越用越准。
 */
const DEFAULT_RTF = Math.max(1, Number(process.env.AMK_RTF_ESTIMATE || 15));
const RTF_WINDOW = 10;
/** 任务记录保留天数：过期任务只留审计用的一小段时间，避免 db.json 无限增长 */
const TASK_KEEP_DAYS = Math.max(1, Number(process.env.TASK_KEEP_DAYS || 7));
/** 只接受合理范围内的实测样本：过小（本地桩/秒回）会让预估失真，过大则明显异常 */
const RTF_MIN = 0.5;
const RTF_MAX = 60;
/** 预估总耗时下限（秒）：避免预估过短导致进度条早早冲到 93% 后长时间不动 */
const MIN_ESTIMATE_SEC = 60;
const rtfSamples = () => (Array.isArray(db.stats?.rtfSamples) ? db.stats.rtfSamples : []);
/**
 * 当前采用的 RTF：有历史样本时取**中位数**（而不是均值）。
 * 均值容易被个别异常样本带偏 —— 比如任务被重启打断、实际耗时被拉长，
 * 会把之后所有任务的预估都抬高；中位数对这种污染不敏感。
 */
function median(list) {
  const arr = [...list].sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
/** 某个模式自己的 RTF 样本（标准模式与全屏模式速度差约 3 倍，必须分开学） */
function modeSamples(mode) {
  const list = db.stats?.byMode?.[mode];
  return Array.isArray(list) ? list : [];
}
/** 当前采用的 RTF：优先用同模式样本的中位数；没有就退回整体中位数 */
function currentRtf(mode) {
  const own = modeSamples(mode);
  if (own.length) return median(own);
  const list = [...rtfSamples()].sort((a, b) => a - b);
  if (!list.length) return DEFAULT_RTF;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
/** 任务完成后记录实测 RTF，供后续任务预估使用 */
function recordRtf(task) {
  // 被重启打断过的任务，墙钟耗时里含重启空档（可能几十分钟），作为样本会把预估带偏
  if (task.wasResumed) {
    console.log('[erase] 该任务经历过服务重启，耗时含空档，不纳入 RTF 预估样本');
    return;
  }
  const real = (Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000;
  if (!(task.durationSec > 0) || !(real > 0)) return;
  const sample = real / task.durationSec;
  if (sample < RTF_MIN || sample > RTF_MAX) {
    console.log(`[erase] 实测 RTF=${sample.toFixed(2)} 超出合理范围（${RTF_MIN}~${RTF_MAX}），不纳入预估样本`);
    return;
  }
  db.stats = db.stats || {};
  db.stats.rtfSamples = [...rtfSamples(), +sample.toFixed(2)].slice(-RTF_WINDOW);
  db.stats.byMode ||= {};
  const key = task.mode === 'Text' ? 'Text' : 'Subtitle';
  db.stats.byMode[key] = [...modeSamples(key), +sample.toFixed(2)].slice(-RTF_WINDOW);
  db.stats.avgRtf = +currentRtf(key).toFixed(2);
  console.log(`[erase] 本次实测 RTF=${sample.toFixed(1)}（${key} 模式，原片 ${task.durationSec}s / 实际 ${Math.round(real)}s），后续该模式预估采用中位数 ${db.stats.avgRtf}`);
}

/** 源文件与产物的存活时间：默认 12 小时（支持小数，便于测试） */
const UPLOAD_TTL_MS = Math.max(0, Number(process.env.UPLOAD_TTL_HOURS ?? 12)) * 3600 * 1000;
/**
 * 是否在服务器保存处理产物。
 * 默认 false：产物只留云端（约 32 小时），预览/下载由浏览器直连云端 —— 不占服务器磁盘与带宽。
 * 想恢复"存本地副本"：环境变量 KEEP_ARTIFACT=true。
 */
const KEEP_ARTIFACT = process.env.KEEP_ARTIFACT === 'true';
/** 过期时长（小时）的中文表述，用于提示文案 */
const ttlHours = () => { const h = UPLOAD_TTL_MS / 3600000; return Number.isInteger(h) ? String(h) : h.toFixed(1); };
const SWEEP_INTERVAL_MS = Math.max(500, Number(process.env.SWEEP_INTERVAL_MS || 5 * 60 * 1000));
/** 会话每天 23:59:59 失效（可用 SESSION_END_MINUTE 调整到别的整点分钟） */
const SESSION_END_MINUTE = Math.min(23 * 60 + 59, Math.max(0, Number(process.env.SESSION_END_MINUTE ?? 23 * 60 + 59)));
const SESSION_COOKIE = 'clp_sid';
const LOGIN_MAX_FAILS = Math.max(3, Number(process.env.LOGIN_MAX_FAILS || 10));
const LOGIN_WINDOW_MS = Math.max(1000, Number(process.env.LOGIN_WINDOW_MS || 10 * 60 * 1000));

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.wmv', '.mpeg', '.mpg', '.ts']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.m4v': 'video/x-m4v',
};

// ---------------------------------------------------------------- 存储层
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const db = { files: {}, tasks: {}, md5Index: {}, sessions: {} };
try {
  Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch {
  /* 首次启动 */
}
db.files ||= {};
db.tasks ||= {};
db.batches ||= {};
db.results ||= {};      // md5 → 已完成产物（内容级复用索引）
db.sessions ||= {};
db.users ||= {};
db.creditLedger ||= [];
db.redemptionCodes ||= {};
// MD5 → fileId 索引（去重的唯一依据，文件名即 MD5）；旧记录没有 md5 字段，顺手补建索引
db.md5Index ||= {};
for (const f of Object.values(db.files)) {
  if (f.md5) db.md5Index[f.md5] = f.id;
}

let saveTimer = null;
let saveWriting = false;   // 是否有写盘正在进行
let savePending = false;   // 写盘期间又发生了变更

/**
 * 落盘：**防抖 + 串行**。
 *  - 防抖：进度回调很密集，避免每次都整份重写
 *  - 串行：同一时刻只允许一个写在飞。之前并发写各自 rename，
 *    旧快照可能后落地把新数据覆盖掉（真的丢过数据），现在写完若期间有变更，
 *    再用**最新快照**补写一次。
 */
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDb, 80);
}

function flushDb() {
  if (saveWriting) { savePending = true; return; }
  saveWriting = true;
  const tmp = `${DB_FILE}.tmp`;
  let payload;
  try {
    payload = JSON.stringify(db, null, 2);
  } catch (err) {
    saveWriting = false;
    return console.error('[db] 序列化失败', err.message);
  }
  fs.writeFile(tmp, payload, (err) => {
    if (err) {
      saveWriting = false;
      console.error('[db] 写入失败', err.message);
      if (savePending) { savePending = false; flushDb(); }
      return;
    }
    fs.rename(tmp, DB_FILE, (e) => {
      saveWriting = false;
      if (e) console.error('[db] 落盘失败', e.message);
      if (savePending) { savePending = false; flushDb(); }
    });
  });
}
/** 同步落盘，退出前调用 */
function saveDbSync() {
  clearTimeout(saveTimer);
  savePending = false;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('[db] 写入失败', err.message);
  }
}

// ---------------------------------------------------------------- 工具
const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

function lanIp() {
  const ifaces = os.networkInterfaces();
  const preferred = ['en0', 'en1', 'eth0', 'wlan0'];
  const flat = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) flat.push({ name, address: a.address });
    }
  }
  flat.sort((a, b) => preferred.indexOf(a.name) - preferred.indexOf(b.name));
  return flat[0]?.address || '127.0.0.1';
}

const LAN_IP = lanIp();
/** 内网（或公网）可达地址；设置 PUBLIC_BASE_URL 可接入域名 / 反向代理 */
const baseUrl = () => PUBLIC_BASE || `http://${LAN_IP}:${PORT}`;
const publicFileUrl = (fileId) => `${baseUrl()}/f/${fileId}`;
const publicDownloadUrl = (taskId) => `${baseUrl()}/api/download/${taskId}`;
const publicPosterUrl = (taskId) => `${baseUrl()}/api/artifacts/${taskId}/poster.svg`;

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  if (res.isHead) return res.end(); // HEAD：只回头，不回 body
  res.end(buf);
}

const sendError = (res, status, message, extra = {}) => sendJson(res, status, { error: message, ...extra });

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

function sanitizeName(raw) {
  const base = path.basename(String(raw || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').trim();
  return (base || 'video.mp4').slice(0, 160);
}

/* ================================================================ 登录鉴权
 * 内部使用，不做复杂账号体系：一个访问 Token + 会话 Cookie。
 * 会话在「当天 23:59:59」失效，第二天必须重新输入 Token。
 * ================================================================= */
const TOKEN_FILE = path.join(DATA_DIR, 'access-token.txt');

function resolveAccessToken() {
  if (process.env.ACCESS_TOKEN) return { token: process.env.ACCESS_TOKEN, source: '环境变量 ACCESS_TOKEN' };
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return { token: t, source: `文件 ${path.relative(__dirname, TOKEN_FILE)}` };
  } catch {
    /* 首次运行 */
  }
  const token = crypto.randomBytes(18).toString('base64url');
  try {
    fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn('[auth] Token 落盘失败（仍可使用本次生成的 Token）:', err.message);
  }
  return { token, source: '自动生成并写入 data/access-token.txt' };
}

const ACCESS_TOKEN = resolveAccessToken();
const TOKEN_DIGEST = crypto.createHash('sha256').update(ACCESS_TOKEN.token).digest();

/** 当天 23:59:59.999 的时间戳（会话统一在这一刻失效） */
function endOfSessionDay(from = Date.now()) {
  const d = new Date(from);
  d.setHours(Math.floor(SESSION_END_MINUTE / 60), SESSION_END_MINUTE % 60, 59, 999);
  return d.getTime();
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isSecureReq = (req) =>
  Boolean(req.socket?.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function setSessionCookie(req, res, sid, maxAgeSec) {
  const bits = [`${SESSION_COOKIE}=${encodeURIComponent(sid)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  bits.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  // 只有请求本身走 HTTPS 时才加 Secure：否则 http://IP:port 直连会因为浏览器丢弃 Cookie 而登录不上
  if (isSecureReq(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

function pruneSessions() {
  const now = Date.now();
  let n = 0;
  for (const [sid, s] of Object.entries(db.sessions)) {
    if (!s || s.expiresAt <= now) {
      delete db.sessions[sid];
      n += 1;
    }
  }
  if (n) saveDb();
  return n;
}

function currentSession(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  const session = db.sessions[sid];
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    delete db.sessions[sid];
    saveDb();
    return null;
  }
  return { sid, ...session };
}

function refundTaskCredits(task, why = 'refund') {
  if (!task || !task.chargedCredits) return 0;
  const user = task.userId ? db.users[task.userId] : null;
  if (user) refundSeconds(db, user, task.chargedCredits, task.id, why);
  const amount = task.chargedCredits;
  task.chargedCredits = 0;
  console.log(`[credits] 退还 ${amount} 积分（${why}，task ${task.id}）`);
  return amount;
}

function currentUser(req) {
  const s = currentSession(req);
  return s?.userId ? db.users[s.userId] || null : null;
}

function createSession(req) {
  const sid = crypto.randomBytes(18).toString('base64url');
  const expiresAt = endOfSessionDay();
  db.sessions[sid] = {
    createdAt: new Date().toISOString(),
    expiresAt,
    ip: clientIp(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
  };
  saveDb();
  return { sid, expiresAt };
}

/** 登录失败限流：同一 IP 在窗口内失败过多直接 429，避免 Token 被暴力枚举 */
const loginFails = new Map();
function noteLoginFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip) || { count: 0, first: now };
  if (now - rec.first > LOGIN_WINDOW_MS) {
    rec.count = 0;
    rec.first = now;
  }
  rec.count += 1;
  loginFails.set(ip, rec);
  return rec;
}
function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginFails.delete(ip);
    return 0;
  }
  return rec.count >= LOGIN_MAX_FAILS ? Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rec.first)) / 1000) : 0;
}

function tokenMatches(input) {
  const got = crypto.createHash('sha256').update(String(input ?? '')).digest();
  return got.length === TOKEN_DIGEST.length && crypto.timingSafeEqual(got, TOKEN_DIGEST);
}

/* ================================================================ 过期清理
 * 上传的源文件到期后过期：删除磁盘文件、移除 MD5 索引，
 * 连带清理该文件派生的任务产物（避免留下无主数据）。
 * ================================================================= */
const fileExpiresAt = (f) => (f.expiresAt ? Date.parse(f.expiresAt) : Date.parse(f.createdAt) + UPLOAD_TTL_MS);
const isFileExpired = (f) => fileExpiresAt(f) <= Date.now();

let sweeping = false;
async function sweepExpired(trigger = 'timer') {
  if (sweeping) return { skipped: true };
  sweeping = true;
  const now = Date.now();
  const removed = [];
  const cleanedTasks = [];
  try {
    for (const f of Object.values(db.files)) {
      if (!isFileExpired(f)) continue;
      await fsp.rm(path.join(DATA_DIR, f.storedPath), { force: true }); // 1) 删文件
      delete db.files[f.id];
      if (db.md5Index[f.md5] === f.id) delete db.md5Index[f.md5]; // 2) 去掉 MD5 信息
      for (const t of Object.values(db.tasks)) {
        if (t.fileId !== f.id) continue;
        if (t.status === 'pending' || t.status === 'processing') t.canceled = true;
        if (t.status !== 'failed' && t.status !== 'canceled') t.status = 'expired';
        t.stage = '源文件已过期，内容已删除';
        t.stageKey = 'expired';
        t.expiredAt = new Date().toISOString();
        t.downloadUrl = null;
        delete t.result;
        await fsp.rm(path.join(OUTPUT_DIR, t.id), { recursive: true, force: true }); // 3) 删派生数据
        cleanedTasks.push(t.id);
      }
      removed.push({ id: f.id, md5: f.md5, name: f.name, size: f.size });
      console.log(`[ttl] 过期清理：${f.name} (${f.id}) 文件与 md5=${f.md5} 索引已删除`);
    }

    // 孤儿临时文件（上传中断 / 进程被杀留下的 .incoming-*）
    let orphans = 0;
    try {
      for (const name of await fsp.readdir(UPLOAD_DIR)) {
        if (!name.startsWith('.incoming-')) continue;
        const abs = path.join(UPLOAD_DIR, name);
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) continue;
        if (trigger === 'startup' || now - st.mtimeMs > 3600_000) {
          await fsp.rm(abs, { force: true });
          orphans += 1;
        }
      }
    } catch (err) {
      console.warn('[ttl] 清理临时文件失败:', err.message);
    }

    // 孤儿产物目录（对应任务已被删除）
    let orphanDirs = 0;
    try {
      for (const name of await fsp.readdir(OUTPUT_DIR)) {
        if (db.tasks[name]) continue;
        await fsp.rm(path.join(OUTPUT_DIR, name), { recursive: true, force: true });
        orphanDirs += 1;
      }
    } catch (err) {
      console.warn('[ttl] 清理产物目录失败:', err.message);
    }

    // 内容级产物索引：指向的任务已不存在 / 已不是成功状态 / 已过期 → 丢弃条目
      let prunedResults = 0;
      for (const md5 of Object.keys(db.results || {})) {
        const rec = db.results[md5];
        const t = db.tasks[rec.taskId];
        if (!t || t.status !== 'succeeded' || !t.result || Date.parse(rec.expiresAt || 0) <= now) {
          delete db.results[md5];
          prunedResults += 1;
        }
      }
      if (prunedResults) console.log(`[reuse] 清理 ${prunedResults} 条失效的产物索引`);

      // 历史任务记录：保留 TASK_KEEP_DAYS 天，避免 db.json 无限增长（每次进度更新都要整份重写）
    // 注意：这一步每轮都要跑，不能只在"删除了源文件"时才执行
    let prunedTasks = 0;
    const keepAfter = now - TASK_KEEP_DAYS * 86400_000;
    for (const [taskId, t] of Object.entries(db.tasks)) {
      if (t.status === 'processing' || t.status === 'pending') continue;
      const ended = Date.parse(t.finishedAt || t.createdAt || 0) || 0;
      if (ended && ended < keepAfter) {
        delete db.tasks[taskId];
        prunedTasks += 1;
      }
    }
    // 历史批次：任务都被清掉后，批次记录也没必要留着
    let prunedBatches = 0;
    for (const [bid, b] of Object.entries(db.batches || {})) {
      const created = Date.parse(b.createdAt || 0) || 0;
      const alive = (b.taskIds || []).some((tid) => db.tasks[tid]);
      if (!alive && created && created < keepAfter) { delete db.batches[bid]; prunedBatches += 1; }
    }

    if (removed.length || cleanedTasks.length || orphans || orphanDirs || prunedTasks) saveDb();
    const dg = diskGuard();
    if (!dg.ok) {
      console.warn(`[disk] 剩余 ${formatBytes(dg.free)}，低于保护线 ${formatBytes(dg.minFree)}：已暂停接收新任务（上传/建批次/开始任务）`);
    }
    if (removed.length || cleanedTasks.length || orphans || orphanDirs || prunedTasks) {
      console.log(
        `[ttl] 本轮清理 ${removed.length} 个源文件、${cleanedTasks.length} 个派生任务、` +
          `${orphans} 个临时文件、${orphanDirs} 个孤儿产物目录、${prunedTasks} 条历史任务记录、${prunedBatches} 个历史批次`,
      );
    }
    return { removed: removed.length, cleanedTasks: cleanedTasks.length, orphans, orphanDirs, prunedTasks, files: removed };
  } finally {
    sweeping = false;
  }
}

const serializeFile = (f) => ({
  ...f,
  names: f.names || [f.name],
  storageName: `${f.md5}${f.ext}`,
  url: publicFileUrl(f.id),
  localUrl: `/f/${f.id}`,
  expiresAt: new Date(fileExpiresAt(f)).toISOString(),
  expiresInMs: Math.max(0, fileExpiresAt(f) - Date.now()),
  sizeText: formatBytes(f.size),
});
const serializeTask = (t) => ({
  ...t,
  // 云端产物地址只留在服务端内部使用，不下发给客户端
  remoteResultUrl: undefined,
  /** 产物预览/下载地址（仅成功任务；过期任务一律为 null，前端据此收起按钮） */
  downloadUrl: t.status === 'succeeded' ? `/api/download/${t.id}` : null,
  publicDownloadUrl: t.status === 'succeeded' ? publicDownloadUrl(t.id) : null,
  previewUrl: (t.status === 'succeeded' || (t.status === 'expired' && t.result?.remote)) && t.result?.hasVideo
    ? `/api/artifacts/${t.id}/video` : null,
  productRemote: !!t.result?.remote,
  productExpiresAt: t.remoteExpiresAt || null,
  /**
   * 去字幕接口产出的云端直连地址（带签名，24 小时有效）。
   * 前端优先用它：浏览器直连 CDN，速度取决于客户端带宽，且不占用本服务器出带宽。
   * 过期或不可用时前端自动回退到本站地址。
   */
  posterUrl: t.status === 'succeeded' ? `/api/artifacts/${t.id}/poster.svg` : null,
  publicPosterUrl: t.status === 'succeeded' ? publicPosterUrl(t.id) : null,
  sizeText: t.result ? formatBytes(t.result.size) : null,
});

// ---------------------------------------------------------------- 文件传输
/** 支持 Range 的静态/文件响应（视频可拖动进度条） */
/** 解析云端签名地址的到期时间（auth_key=<epoch>-…）；解析不到返回 null */
function urlExpiry(url) {
  const m = /auth_key=(\d{9,})/.exec(String(url || ''));
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
}
/** 云端产物是否还有效（不存副本模式下判断能否继续预览/下载） */
function remoteAlive(task) {
  if (!task?.remoteResultUrl) return false;
  if (!task.remoteExpiresAt) return true;
  return Date.parse(task.remoteExpiresAt) > Date.now();
}

function serveFile(req, res, absPath, { mime, downloadName, cache = 'no-store' } = {}) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return sendError(res, 404, '文件不存在');
  }
  const type = mime || MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cache,
    'access-control-allow-origin': '*',
  };
  if (downloadName) {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? Math.max(0, stat.size - Number(m[2])) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? stat.size - 1 : Number(m[2]);
    start = Math.min(start, stat.size - 1);
    end = Math.min(end, stat.size - 1);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(absPath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(absPath).pipe(res);
}

// ---------------------------------------------------------------- 上传
const MD5_RE = /^[0-9a-f]{32}$/;

/** 文件是否存在且是正常文件（索引可能指向被手工删除的 blob） */
async function blobExists(file) {
  if (!file) return false;
  try {
    const st = await fsp.stat(path.join(DATA_DIR, file.storedPath));
    return st.isFile() && st.size === file.size;
  } catch {
    return false;
  }
}

/** 按文件的唯一 ID（vf_xxx）取文件；已过期的按不存在处理 */
function findFileByKey(key) {
  if (!key) return null;
  const file = db.files[key];
  return file && !isFileExpired(file) ? file : null;
}

/** 秒传预检：客户端先算好 MD5，命中就不必再传一遍字节 */
async function handlePrecheck(req, res) {
  const body = await readJsonBody(req);
  const md5 = String(body.md5 || '').toLowerCase();
  if (!MD5_RE.test(md5)) return sendError(res, 400, 'md5 必须是 32 位十六进制字符串');
  const hit = db.files[db.md5Index[md5]];
  if (!hit || isFileExpired(hit) || !(await blobExists(hit))) {
    if (hit && isFileExpired(hit)) {
      // 过期文件的索引可能还没被扫描到：立刻清掉，避免秒传误命中已删除的内容
      delete db.md5Index[md5];
      saveDb();
      await sweepExpired('lazy');
      console.log(`[precheck] ${md5} 已过期，按未命中处理`);
    }
    if (!hit) return sendJson(res, 200, { exists: false, md5 });
    if (isFileExpired(hit)) return sendJson(res, 200, { exists: false, md5, expired: true });

    delete db.md5Index[md5]; // 索引失效，让客户端正常上传
    saveDb();
    return sendJson(res, 200, { exists: false, md5, stale: true });
  }
  // 秒传也要留下痕迹：记录新文件名作为别名，便于回溯「这份内容都叫过什么」
  const name = body.name ? sanitizeName(String(body.name)) : null;
  hit.names = [...new Set([...(hit.names || [hit.name]), ...(name ? [name] : [])])].slice(0, 20);
  hit.hits = (hit.hits || 1) + 1;
  hit.lastSeenAt = new Date().toISOString();
  saveDb();
  console.log(
    `[precheck] 命中 ${md5} -> ${hit.id}，跳过上传 ${formatBytes(hit.size)}` +
      `${name ? `（本次文件名 ${name}）` : ''}`,
  );
  sendJson(res, 200, { exists: true, md5, file: serializeFile(hit), savedBytes: hit.size });
}

async function handleUpload(req, res) {
  // 磁盘低于保护线：先别收文件，避免把已经紧张的磁盘写满
  const diskCheck = diskGuard();
  if (!diskCheck.ok) {
    return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
  }
  // 文件名：浏览器会做 encodeURIComponent，这里解码；对没编码过的原始名字也要容错（不能因为解码失败就 500）
  const rawHeader = String(req.headers['x-file-name'] || 'video.mp4');
  let decodedName = rawHeader;
  try { decodedName = decodeURIComponent(rawHeader); } catch { decodedName = rawHeader; }
  const rawName = sanitizeName(decodedName);
  const ext = (path.extname(rawName) || '.mp4').toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    return sendError(res, 415, `不支持的文件类型 ${ext}`, { allowed: [...VIDEO_EXT] });
  }
  // 客户端可携带已验证的 MD5；不传则服务端自己算，仍然享受上传后的去重
  const declaredMd5 = String(req.headers['x-file-md5'] || '').toLowerCase();
  if (declaredMd5 && !MD5_RE.test(declaredMd5)) {
    return sendError(res, 400, 'X-File-MD5 必须是 32 位十六进制字符串');
  }

  // 先写临时文件，算出 MD5 后才能决定最终文件名（内容寻址）
  const tmpPath = path.join(UPLOAD_DIR, `.incoming-${crypto.randomBytes(8).toString('hex')}`);
  const md5 = crypto.createHash('md5');
  const sha256 = crypto.createHash('sha256');
  let received = 0;

  const guard = async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        throw Object.assign(new Error('文件超过大小限制'), { status: 413 });
      }
      md5.update(chunk);
      sha256.update(chunk);
      yield chunk;
    }
  };

  const t0 = Date.now();
  try {
    await pipeline(req, guard, fs.createWriteStream(tmpPath));
  } catch (err) {
    await fsp.rm(tmpPath, { force: true });
    if (err.status) return sendError(res, err.status, err.message, { maxBytes: MAX_UPLOAD_BYTES });
    return; // 客户端中断
  }
  if (received === 0) {
    await fsp.rm(tmpPath, { force: true });
    return sendError(res, 400, '上传内容为空');
  }

  const digest = md5.digest('hex');
  if (declaredMd5 && declaredMd5 !== digest) {
    await fsp.rm(tmpPath, { force: true });
    return sendError(res, 400, '文件 MD5 与客户端声明不一致，上传可能已损坏，请重试', {
      declared: declaredMd5,
      actual: digest,
    });
  }

  // ---- 去重：同 MD5 已在服务器上，直接丢弃刚写入的临时文件 ----
  const existing = db.files[db.md5Index[digest]];
  if (await blobExists(existing)) {
    await fsp.rm(tmpPath, { force: true });
    existing.names = [...new Set([...(existing.names || [existing.name]), rawName])].slice(0, 20);
    existing.lastSeenAt = new Date().toISOString();
    existing.hits = (existing.hits || 1) + 1;
    saveDb();
    console.log(
      `[dedupe] ${digest} 已存在（${existing.id}），复用服务器文件，本次未占用新空间 ${formatBytes(received)}`,
    );
    return sendJson(res, 200, {
      file: serializeFile(existing),
      deduped: true,
      savedBytes: received,
      md5: digest,
    });
  }

  // ---- 落盘：文件名就是 MD5，扩展名沿用本次上传 ----
  const storedPath = path.join(UPLOAD_DIR, `${digest}${ext}`);
  await fsp.rm(storedPath, { force: true });
  await fsp.rename(tmpPath, storedPath);

  const fileId = id('vf');
  const file = {
    id: fileId,
    md5: digest,
    name: rawName,
    names: [rawName],
    ext,
    size: received,
    mime: MIME[ext] || req.headers['content-type'] || 'video/mp4',
    storedPath: path.relative(DATA_DIR, storedPath),
    sha256: sha256.digest('hex'),
    hits: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(), // 到期时间（UPLOAD_TTL_HOURS 可配）
  };
  db.files[fileId] = file;
  db.md5Index[digest] = fileId;
  saveDb();

  console.log(
    `[upload] ${fileId} ${rawName} ${formatBytes(received)} in ${Date.now() - t0}ms` +
      ` md5=${digest}${declaredMd5 ? '（与客户端一致）' : ''} -> uploads/${digest}${ext}`,
  );
  sendJson(res, 200, { file: serializeFile(file), deduped: false, md5: digest });
}

// ---------------------------------------------------------------- 任务队列
const queue = [];
let running = 0;

/**
 * 启动时处理中断的任务。
 * 进程重启后，之前标记为「处理中」的任务已经没有 worker 在跑了：如果不处理，
 * 前端就会永远停在「正在处理中……」。
 *   · 已经提交到去字幕接口的（有 remoteTaskId）→ 重新接管，继续等待并回传结果
 *   · 还没提交成功的 → 标记失败，让用户重新提交
 */
function recoverInterruptedTasks() {
  let resumed = 0;
  let requeued = 0;
  let idle = 0;
  for (const task of Object.values(db.tasks)) {
    if (task.status !== 'processing' && task.status !== 'pending') continue;
    if (task.remoteTaskId) {
      task.status = 'pending';
      task.resume = true;
      task.wasResumed = true;      // 耗时里含重启空档，不能作为 RTF 样本
      task.stage = '服务重启，等待接管';
      resumed += 1;
      enqueue(task.id);
    } else if (!task.started) {
      /* 用户建好了任务但还没点「开始任务」：保持"待开始"，绝不能自动跑起来 */
      task.status = 'pending';
      task.progress = 0;
      task.stage = '等待开始';
      task.etaSeconds = task.estimatedSeconds ?? null;
      idle += 1;
    } else {
      /*
       * 用户点过开始、但还没拿到接口 task_id（在本地队列里等着，或提交请求发出后没收到响应）：
       * 直接判失败要用户重来，体验很差。这里改成**自动重新排队**。
       * 安全性：去字幕接口按输入地址去重（同一个 video_url 会返回同一个 task_id），
       * 所以即使上一次提交其实已经到达云端，重排也不会重复处理。
       */
      task.status = 'pending';
      task.progress = 0;
      task.stage = '服务重启，自动重新排队';
      task.error = null;
      task.canceled = false;
      task.startedAt = null;
      task.etaSeconds = task.estimatedSeconds ?? null;
      task.wasResumed = true;      // 用于"不把重启导致的耗时算进 RTF 样本"
      requeued += 1;
      enqueue(task.id);
    }
  }
  if (resumed || requeued || idle) {
    saveDb();
    console.log(`  重启接管    ${resumed} 个已提交到接口的任务`);
    if (requeued) console.log(`  自动重排    ${requeued} 个已开始但未提交的任务（不判失败）`);
    if (idle) console.log(`  保持待开始  ${idle} 个用户还没点开始的任务`);
  }
}

function enqueue(taskId) {
  const task = db.tasks[taskId];
  if (task && !task.started) {
    task.started = true;     // 落库：重启后据此判断"这个任务本来就在跑"
    saveDb();
  }
  queue.push(taskId);
  pump();
}

function pump() {
  while (running < MAX_ACTIVE_TASKS && queue.length) {
    const taskId = queue.shift();
    const task = db.tasks[taskId];
    if (!task || task.status !== 'pending') continue;
    running += 1;
    execute(task)
      .catch((err) => console.error('[worker] 未捕获异常', err))
      .finally(() => {
        running -= 1;
        saveDb();
        pump();
      });
  }
}

async function execute(task) {
  // 用户取消过（可能取消时它还在本地队列里）→ 直接落地为已取消，绝不翻回"处理中"
  if (task.canceled) {
    task.status = 'canceled';
    task.stage = '已取消';
    task.stageKey = 'canceled';
    task.finishedAt = task.finishedAt || new Date().toISOString();
    saveDb();
    console.log(`[worker] ${task.id} 已取消，跳过执行`);
    return;
  }
  const file = db.files[task.fileId];
  // 接管模式：接口那边已经提交过，重启后只需要继续等待并回传结果
  const resume = task.resume === true && Boolean(task.remoteTaskId);
  task.status = 'processing';
  if (!resume) {
    // 接管时保留原有的开始时间与已用时长，进度与剩余时间跨重启保持连续
    task.startedAt = new Date().toISOString();
    task.elapsedSeconds = 0;
    task.etaSeconds = task.estimatedSeconds ?? null;
  }
  task.progress = resume ? Math.max(Number(task.progress) || 0, 10) : 1;
  task.stage = resume ? '服务重启，正在接管任务' : '任务已进入去字幕队列';
  saveDb();

  try {
    if (!file && !resume) throw new Error('源文件不存在或已被清理');
    if (file && isFileExpired(file) && !resume) throw new Error(`源文件已过期（超过 ${ttlHours()} 小时）并被删除，请重新上传`);
    const srcPath = file ? path.join(DATA_DIR, file.storedPath) : null;
    const outDir = path.join(OUTPUT_DIR, task.id);
    const outcome = await runPipeline(
      task,
      {
        srcPath,
        outDir,
        operation: task.operation,
        mode: task.mode || OPERATIONS[task.operation]?.mode || 'Subtitle',
        // 擦除区域（可选）：null 表示不传，走接口默认区域
        eraseRatioLocation: task.eraseRatioLocation || null,
        keepArtifact: KEEP_ARTIFACT,
        modelVersion: task.modelVersion || null,
        // 接管时源文件可能已被清理，用任务里保存的元信息兜底（只用于产物命名与封面）
        file: file || { name: task.fileName || 'video.mp4', ext: path.extname(task.fileName || '.mp4'), size: task.fileSize || 0 },
        // 云端引擎需要「云端能拉到的地址」；/f/<id> 是不可猜测的能力 URL，可匿名访问
        videoUrl: file ? publicFileUrl(file.id) : null,
        resume,
        // 两阶段闸门：提交可并发、回传限流
        gate: {
          submit: (fn) => submitPool.run(fn),
          fetch: (fn) => fetchPool.run(async () => {
            // 回传限流生效时打一条日志（排队说明并发上限起了作用）
            if (fetchPool.waiting > 0) {
              console.log(`[gate] 回传限流：进行中 ${fetchPool.active}/${FETCH_CONCURRENCY}，排队 ${fetchPool.waiting}`);
            }
            return fn();
          }),
        },
        // 提交成功后立刻把接口任务 ID 落库，重启后才能凭它接管
        setRemoteTaskId: (id) => { task.remoteTaskId = id; saveDb(); },
      },
      ({ progress, stage, stageKey, etaSeconds, elapsedSeconds }) => {
        // 进度只增不减：接管任务时避免进度条回退
        task.progress = Math.max(Number(task.progress) || 0, Number(progress) || 0);
        task.stage = stage;
        task.stageKey = stageKey;
        if (Number.isFinite(elapsedSeconds)) task.elapsedSeconds = elapsedSeconds;
        if (Number.isFinite(etaSeconds)) task.etaSeconds = etaSeconds;
        if (task.canceled) return; // 已取消：不再覆盖状态
        saveDb();
      },
    );

    if (task.canceled) return;
    const kept = outcome.kept !== false;
    const stat = kept ? await fsp.stat(outcome.outputs.video) : null;
    const op = OPERATIONS[task.operation];
    task.status = 'succeeded';
    task.progress = 100;
    task.stage = '去字幕完成';
    task.stageKey = 'done';
    task.finishedAt = new Date().toISOString();
    task.elapsedSeconds = Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000);
    task.etaSeconds = 0;
    recordRtf(task);
    task.remoteTaskId = outcome.remoteTaskId || task.remoteTaskId || null;
    delete task.resume;
    task.result = {
      name: `${path.basename(file.name, file.ext)}-无字幕${op.outputExt}`,
      size: kept ? stat.size : (outcome.size || 0),
      hasVideo: true,
      poster: true,
      remote: !kept,
    };
    if (!kept) {
      task.remoteResultUrl = outcome.remoteUrl || null;
      task.remoteExpiresAt = urlExpiry(outcome.remoteUrl);
    }
    rememberResult(task);        // 登记"内容 → 产物"（必须在 result 赋值之后），供之后的同内容复用
    console.log(
      `[worker] ${task.id} 去字幕完成，用时 ${outcome.durationMs}ms，产物 ${formatBytes(kept ? stat.size : (outcome.size || 0))}${kept ? '' : '（云端保存，未落盘）'}`,
    );
  } catch (err) {
    if (task.status !== 'canceled') refundTaskCredits(task, 'refund:failed');
    task.status = err.code === 'CANCELED' ? 'canceled' : 'failed';
    task.stage = err.code === 'CANCELED' ? '已取消' : '处理失败';
    task.error = err.code === 'CANCELED' ? null : err.message || '未知错误';
    task.finishedAt = new Date().toISOString();
    console.warn(`[worker] ${task.id} ${task.status}: ${err.message}`);
  }
}

/**
 * 取消任务：先尽力通知云端终止（官方目前无该接口，会退化为停止本地跟踪），
 * 再在本地标记为已取消 —— 之后不再轮询、不再下载产物。
 */
async function cancelTasks(tasks) {
  const list = tasks.filter(Boolean);
  if (!list.length) return { remoteOk: 0, remoteFailed: 0, noRemote: 0, notes: [] };
  await Promise.all(list.map(async (task) => {
    if (task.remoteTaskId) {
      task.remoteCancel = await cancelRemoteTask(task.remoteTaskId);
    } else {
      task.remoteCancel = { attempted: false, ok: false, note: '任务还没提交到接口，无需取消' };
    }
  }));
  const summary = { remoteOk: 0, remoteFailed: 0, noRemote: 0, notes: [] };
  for (const t of list) refundTaskCredits(t, 'refund:cancel');
  for (const t of list) {
    if (t.remoteCancel?.ok) summary.remoteOk += 1;
    else if (t.remoteCancel?.attempted) { summary.remoteFailed += 1; if (!summary.notes.includes(t.remoteCancel.note)) summary.notes.push(t.remoteCancel.note); }
    else summary.noRemote += 1;
  }
  console.log(`[cancel] ${list.length} 个任务：云端接受 ${summary.remoteOk} · 云端无此能力 ${summary.remoteFailed} · 未提交 ${summary.noRemote}`);
  return summary;
}

/**
 * 彻底清理一份内容（「移除任务」用）：
 *   源文件 + 去字幕产物 + db.files + db.md5Index + db.results + 产物目录
 * 只要还有**任何批次行或任务**在引用它，就保留（否则会打断别人正在用的预览/下载）。
 */
async function purgeContent({ fileId, taskId } = {}) {
  const file = fileId ? db.files[fileId] : null;
  const task = taskId ? db.tasks[taskId] : null;
  const out = { removedFile: false, removedTask: false, removedMd5: false, freedBytes: 0, keptFile: null, keptTask: null };

  const itemRefs = (pred) => Object.values(db.batches || {}).some((b) => (b.items || []).some(pred));
  const taskRefs = (tid) => itemRefs((it) => it.taskId === tid);
  const fileRefs = (fid) => itemRefs((it) => it.fileId === fid)
    || Object.values(db.tasks || {}).some((t) => t.fileId === fid && t.id !== taskId);

  // ① 产物 + 任务记录 + 产物目录
  if (task && !taskRefs(task.id)) {
    out.freedBytes += task.result?.size || 0;
    delete db.tasks[task.id];
    await fsp.rm(path.join(OUTPUT_DIR, task.id), { recursive: true, force: true }).catch(() => {});
    for (const md5 of Object.keys(db.results || {})) {
      if (db.results[md5].taskId === task.id) delete db.results[md5];
    }
    out.removedTask = true;
  } else if (task) {
    out.keptTask = '产物仍被其它行复用';
  }

  // ② 源文件 + MD5 索引 + 内容索引
  if (file && !fileRefs(file.id)) {
    out.freedBytes += file.size || 0;
    await fsp.rm(path.join(DATA_DIR, file.storedPath), { force: true }).catch(() => {});
    delete db.files[file.id];
    if (file.md5 && db.md5Index[file.md5] === file.id) { delete db.md5Index[file.md5]; out.removedMd5 = true; }
    if (file.md5 && db.results?.[file.md5]) delete db.results[file.md5];
    out.removedFile = true;
  } else if (file) {
    out.keptFile = '源文件仍被其它行使用';
  }
  return out;
}

/** 可用磁盘空间（字节） */
function freeDiskBytes(dir = DATA_DIR) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * 建一条任务记录（不排队）。批次里的每个「唯一内容」都走这里，
 * 单文件接口也复用，保证两种入口的字段一致。
 */
function createTaskForFile(file, { operation = DEFAULT_OPERATION, durationSec, userId, eraseRegion, eraseMode, modelVersion } = {}) {
  const dur = Number(durationSec);
  const hasDuration = Number.isFinite(dur) && dur > 0.5 && dur < 6 * 3600;
  const mode = resolveEraseMode(eraseMode || OPERATIONS[operation]?.mode || 'Subtitle');
  // 优先用同模式的历史速度；该模式还没有样本时，用整体中位数（全屏模式再 ×3 兜底）
  const hasModeSamples = modeSamples(mode).length > 0;
  const modeFactor = hasModeSamples ? 1 : (mode === 'Text' ? 3 : 1);
  const estimatedSeconds = hasDuration
    ? Math.max(MIN_ESTIMATE_SEC, Math.round(dur * currentRtf(mode) * modeFactor))
    : null;
  // 强力模式自动用最新模型（v5.6）
  const model = resolveModelVersion(modelVersion) || (mode === 'Text' ? 'v5.6' : null);
  const task = {
    id: id('task'),
    fileId: file.id,
    fileName: file.name,
    fileSize: file.size,
    userId: userId || null,
    operation,
    operationLabel: OPERATIONS[operation].label,
    mode,                                        // Subtitle | Text
    modelVersion: model,                         // v4 | v5 | v5.6（null = 接口默认）
    eraseRatioLocation: resolveEraseRegion(eraseRegion),   // null = 不传，用接口默认区域
    stages: STAGES.map(({ key, label, weight }) => ({ key, label, weight })),
    status: 'pending',
    started: false,          // 用户是否点过「开始任务」；没点过的重启后必须保持"待开始"，绝不自动跑
    progress: 0,
    stage: '等待开始',
    createdAt: new Date().toISOString(),
    sourceExpiresAt: new Date(fileExpiresAt(file)).toISOString(),
    durationSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
    estimatedSeconds,
    elapsedSeconds: 0,
    etaSeconds: estimatedSeconds,
  };
  db.tasks[task.id] = task;
  saveDb();
  return task;
}

/**
 * 建批次：一次提交的一批文件。
 * 批内按 MD5 去重 —— 内容相同的文件只建一个任务，其余条目共享它的结果（秒传）。
 */
/* ============================================================
 * 内容级产物索引：源文件 MD5 → 已完成产物
 * 目的：同一个视频（哪怕改了文件名、隔了几个批次）再上传时，
 *       直接把服务器上已经去好字幕的那份拿出来复用，不重复调接口。
 * ========================================================== */
function resultOfMd5(md5) {
  const rec = db.results?.[md5];
  if (!rec) return null;
  const task = db.tasks[rec.taskId];
  // 任务被清理、产物被删、源文件过期 → 索引条目作废
  if (!task || task.status !== 'succeeded' || !task.result || Date.parse(rec.expiresAt || 0) <= Date.now()) {
    delete db.results[md5];
    return null;
  }
  return { rec, task };
}

/** 任务成功时登记：这个内容已经有产物了 */
function rememberResult(task) {
  const file = db.files[task.fileId];
  if (!file?.md5 || task.status !== 'succeeded' || !task.result) return;
  db.results ||= {};
  db.results[file.md5] = {
    taskId: task.id,
    fileId: file.id,
    name: task.result.name,
    size: task.result.size,
    hasVideo: Boolean(task.result.hasVideo),
    finishedAt: task.finishedAt || new Date().toISOString(),
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),  // 与源文件同寿命
    reused: db.results[file.md5]?.reused || 0,
  };
  console.log(`[reuse] 已登记产物索引 md5=${file.md5} → ${task.id}（${task.result.name}）`);
}

/** 复用命中：把源文件与产物的有效期顺延一个 TTL（用户刚重新上传，理应重新计时） */
function renewForReuse(file, task) {
  const until = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
  file.expiresAt = until;
  if (task) task.sourceExpiresAt = until;
  if (db.results?.[file.md5]) db.results[file.md5].expiresAt = until;
  return until;
}

/**
 * 把一批文件追加到批次里（建批次与"分批添加"共用同一套去重逻辑）。
 * 去重范围：批次内已有内容 + 本次新增内容之间，内容相同的行共享同一个任务。
 */
function appendFilesToBatch(batch, fileIds, durations = {}, overrides = {}) {
  const byMd5 = new Map();      // 本批内已有内容的 md5 → taskId
  const firstOfMd5 = new Map(); // md5 → 第一个用到的 fileId（提示"复用了谁的结果"）
  for (const it of batch.items) {
    const f = db.files[it.fileId];
    if (f?.md5 && it.taskId && !byMd5.has(f.md5)) {
      byMd5.set(f.md5, it.taskId);
      firstOfMd5.set(f.md5, it.fileId);
    }
  }
  // 跨批次：同一内容正在排队/处理中的任务，直接挂上去共享进度，不再提交一次
  const activeByMd5 = new Map();
  for (const t of Object.values(db.tasks)) {
    if (t.status !== 'pending' && t.status !== 'processing') continue;
    const f = db.files[t.fileId];
    if (f?.md5 && !activeByMd5.has(f.md5)) activeByMd5.set(f.md5, { task: t, fileId: f.id });
  }

  const added = [];
  for (const fid of fileIds) {
    const file = db.files[fid];

    // ① 本批里已有相同内容 → 共享同一行任务
    const inBatch = byMd5.get(file.md5);
    if (inBatch) {
      batch.items.push({ fileId: fid, taskId: inBatch, shared: true, sharedWithFileId: firstOfMd5.get(file.md5) || null });
      added.push({ fileId: fid, taskId: inBatch, shared: true });
      continue;
    }

    // ② 服务器上已经有这个内容的去字幕产物 → 直接复用，不建任务、不调接口
    const hit = resultOfMd5(file.md5);
    if (hit) {
      renewForReuse(file, hit.task);
      db.results[file.md5].reused = (db.results[file.md5].reused || 0) + 1;
      batch.items.push({
        fileId: fid, taskId: hit.task.id, shared: true, reused: true,
        sharedWithFileId: hit.rec.fileId,
      });
      added.push({ fileId: fid, taskId: hit.task.id, shared: true, reused: true });
      console.log(`[reuse] ${file.name} 命中已有产物 ${hit.task.id}，跳过重复去字幕（第 ${db.results[file.md5].reused} 次复用）`);
      continue;
    }

    // ③ 相同内容正在处理中 → 挂到那个任务上，共享进度
    const running = activeByMd5.get(file.md5);
    if (running) {
      batch.items.push({
        fileId: fid, taskId: running.task.id, shared: true, attached: true,
        sharedWithFileId: running.fileId,
      });
      added.push({ fileId: fid, taskId: running.task.id, shared: true, attached: true });
      console.log(`[reuse] ${file.name} 与正在处理的任务 ${running.task.id} 合并，不重复提交`);
      continue;
    }

    // ④ 全新内容 → 建任务（等用户点开始）
    const eff = applyErasePreset({
      preset: overrides.erasePreset || batch.erasePreset,
      region: overrides.eraseRegion,
      mode: overrides.eraseMode,
      model: overrides.modelVersion,
    });
    const task = createTaskForFile(file, {
      operation: batch.operation, durationSec: durations[fid], userId: batch.userId || null,
      eraseRegion: eff.region, eraseMode: eff.mode, modelVersion: eff.model,
    });
    task.erasePreset = eff.preset;
    byMd5.set(file.md5, task.id);
    firstOfMd5.set(file.md5, fid);
    batch.taskIds.push(task.id);
    batch.items.push({ fileId: fid, taskId: task.id, shared: false });
    added.push({ fileId: fid, taskId: task.id, shared: false });
  }
  return added;
}

function createBatch({ fileIds, operation = DEFAULT_OPERATION, durations = {}, userId, erasePreset = 'standard', eraseRegion, eraseMode, modelVersion } = {}) {
  db.batches ||= {};
  const batch = {
    id: id('batch'),
    createdAt: new Date().toISOString(),
    operation,
    erasePreset: resolveErasePreset(erasePreset),
    userId: userId || null,
    taskIds: [],
    items: [],
  };
  appendFilesToBatch(batch, fileIds, durations, { erasePreset: batch.erasePreset, eraseRegion, eraseMode, modelVersion });
  db.batches[batch.id] = batch;
  saveDb();
  const reusedN = batch.items.filter((i) => i.reused).length;
  const attachedN = batch.items.filter((i) => i.attached).length;
  console.log(
    `[batch] ${batch.id} 新建：${fileIds.length} 个文件 / 新建任务 ${batch.taskIds.length} 个` +
    (reusedN ? `，复用已有产物 ${reusedN} 个（未重复去字幕）` : '') +
    (attachedN ? `，合并进行中 ${attachedN} 个` : ''),
  );
  return batch;
}

/** 把任务状态映射成界面行状态 */
function itemStatus(task) {
  if (!task) return 'idle';
  if (task.status === 'pending') return 'idle';            // 已建任务但还没开始
  if (task.status === 'processing') return task.stageKey === 'cloud' || task.stageKey === 'fetch' ? 'running' : 'queued';
  return task.status;                                       // succeeded / failed / canceled / expired
}

/** 磁盘是否已低于保护线（低于则暂停接收新任务） */
function diskGuard() {
  const free = freeDiskBytes();
  if (free === null) return { ok: true, free: null, minFree: DISK_MIN_FREE_BYTES };
  return { ok: free >= DISK_MIN_FREE_BYTES, free, minFree: DISK_MIN_FREE_BYTES };
}
const diskLowMessage = (free) =>
  `服务器磁盘空间不足（剩余 ${formatBytes(free)}，低于 ${formatBytes(DISK_MIN_FREE_BYTES)} 保护线），已暂停接收新任务，请联系管理员清理`;

/**
 * 取出本次要操作的行号：
 *   · body.indexes 或 ?indexes=0,2   → 只操作这些行（对应界面里勾选的任务）
 *   · 都不给                          → 整批
 */
function pickedIndexes(req, body, total) {
  const raw = body?.indexes ?? new URL(req.url, 'http://x').searchParams.get('indexes');
  const all = [...Array(total).keys()];
  if (raw === undefined || raw === null || raw === '') return all;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [...new Set(list.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n < total))];
  return out.length ? out : all;
}

/** 批次 → 前端一次性拿全的载荷（列表 + 计数 + 总体进度 + ETA） */
function serializeBatch(batch) {
  const items = batch.items.map((it) => {
    const file = db.files[it.fileId];
    const task = it.taskId ? db.tasks[it.taskId] : null;
    const st = itemStatus(task);
    return {
      fileId: it.fileId,
      fileName: task?.fileName || file?.name || '（已过期）',
      size: task?.fileSize || file?.size || 0,
      sizeText: formatBytes(task?.fileSize || file?.size || 0),
      durationSec: task?.durationSec ?? null,
      md5: file?.md5 || null,
      taskId: it.taskId,
      shared: Boolean(it.shared),
      reused: Boolean(it.reused),        // 复用了已完成的历史产物（没重复去字幕）
      attached: Boolean(it.attached),    // 合并到正在处理的任务（没重复提交）
      sharedWithFileId: it.sharedWithFileId || null,
      sourceExpiresAt: task?.sourceExpiresAt || (file ? new Date(fileExpiresAt(file)).toISOString() : null),
      // 行状态与进度
      status: st,
      progress: task?.progress ?? 0,
      stage: task?.stage || '',
      stageKey: task?.stageKey || null,
      error: task?.error || null,
      elapsedSeconds: task?.elapsedSeconds ?? null,
      etaSeconds: task?.etaSeconds ?? null,
      // 产物（仅成功任务）
      result: task?.result ? { name: task.result.name, size: task.result.size, sizeText: formatBytes(task.result.size) } : null,
      downloadUrl: task && task.status === 'succeeded' ? `/api/download/${task.id}` : null,
      previewUrl: task && task.status === 'succeeded' && task.result?.hasVideo ? `/api/artifacts/${task.id}/video` : null,
      productRemote: !!task?.result?.remote,
      productExpiresAt: task?.remoteExpiresAt || null,
      remoteCancel: task?.remoteCancel || null,
    };
  });
  const count = (st) => items.filter((x) => x.status === st).length;
  const counts = {
    total: items.length,
    idle: count('idle'),
    queued: count('queued'),
    running: count('running'),
    done: count('done') + count('succeeded') + count('skip'),
    failed: count('failed'),
    canceled: count('canceled'),
    expired: count('expired'),
    shared: items.filter((x) => x.shared).length,
    tasks: [...new Set(batch.items.map((i) => i.taskId).filter(Boolean))].length,
  };
  // 总进度：已完成算满，进行中按各自进度折算
  const refTaskIds = [...new Set(batch.items.map((i) => i.taskId).filter(Boolean))];   // 含复用/合并进来的任务
  const taskPct = refTaskIds.reduce((a, tid) => {
    const t = db.tasks[tid];
    if (!t) return a;
    if (t.status === 'succeeded') return a + 100;
    if (t.status === 'processing') return a + (Number(t.progress) || 0);
    return a;
  }, 0);
  const progressPct = refTaskIds.length ? Math.round(taskPct / refTaskIds.length) : 0;
  // 整批 ETA：并发执行，所以取"还未完成任务的剩余时间"的最大值
  const etas = refTaskIds
    .map((tid) => db.tasks[tid])
    .filter((t) => t && (t.status === 'pending' || t.status === 'processing'))
    .map((t) => (Number.isFinite(Number(t.etaSeconds)) ? Number(t.etaSeconds) : (t.estimatedSeconds || 0)));
  const etaSeconds = etas.length ? Math.max(...etas) : 0;
  return {
    batch: {
      id: batch.id,
      createdAt: batch.createdAt,
      operation: batch.operation,
      erasePreset: batch.erasePreset || 'standard',
      // 显示"生效的"参数（由预设解析而来），而不是 null
      eraseRegion: (() => {
        const e = applyErasePreset({ preset: batch.erasePreset, region: batch.eraseRegion ?? undefined, mode: batch.eraseMode ?? undefined, model: batch.modelVersion ?? undefined });
        return e.region ? 'custom' : 'auto';
      })(),
      eraseMode: applyErasePreset({ preset: batch.erasePreset, region: batch.eraseRegion ?? undefined, mode: batch.eraseMode ?? undefined, model: batch.modelVersion ?? undefined }).mode,
      modelVersion: applyErasePreset({ preset: batch.erasePreset, region: batch.eraseRegion ?? undefined, mode: batch.eraseMode ?? undefined, model: batch.modelVersion ?? undefined }).model,
      counts,
      progressPct,
      etaSeconds,
      disk: { free: freeDiskBytes() },
    },
    items,
  };
}

// ---------------------------------------------------------------- 路由
/** 去字幕引擎：显式指定 > auto（有密钥且配了公网入口才走云端）> 离线模拟 */
/** 去字幕接口配置（未配置时任务会被拒绝，不会有任何替代实现） */
const eraseApi = eraseApiConfig();

const ROUTES = {
  'GET /api/config': async (req, res) => {
    sendJson(res, 200, {
      service: 'ClipFlow',
      baseUrl: baseUrl(),
      lanIp: LAN_IP,
      port: PORT,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      allowedExtensions: [...VIDEO_EXT],
      concurrency: { active: MAX_ACTIVE_TASKS, submit: SUBMIT_CONCURRENCY, fetch: FETCH_CONCURRENCY },
      maxBatchSize: MAX_BATCH_SIZE,
      uploadConcurrency: UPLOAD_CONCURRENCY,
      uploadTtlHours: UPLOAD_TTL_MS / 3600000,
      disk: { free: freeDiskBytes(), minFree: DISK_MIN_FREE_BYTES, outputFactor: DISK_OUTPUT_FACTOR },
      ttl: {
        hours: UPLOAD_TTL_MS / 3600000,
        note: '源文件与派生产物到期后自动删除，同时移除 MD5 索引',
        sweepIntervalMs: SWEEP_INTERVAL_MS,
      },
      session: {
        endMinutes: SESSION_END_MINUTE,
        endAt: new Date(endOfSessionDay()).toISOString(),
        note: '会话每天 23:59 失效，次日需重新登录',
      },
      // 版本号：页面底部展示，便于确认线上跑的是哪次部署
      build: BUILD_ID,
      // 去字幕服务是否可用：只给布尔量与缺失项的中文说明，不含任何密钥
      eraseReady: eraseApi.ready,
      eraseMissing: eraseApi.missing.map((m) => (m === 'AMK_API_KEY' ? '去字幕接口密钥' : '公网访问入口')),
      dedupe: { key: 'md5', storage: 'content-addressed', precheck: '/api/uploads/precheck' },
      stages: STAGES.map(({ key, label, weight }) => ({ key, label, weight })),
      operations: Object.values(OPERATIONS).map(({ id: opId, label, desc, accent }) => ({ id: opId, label, desc, accent })),
    });
  },

  /* ---------------- 鉴权（无需登录即可访问的两个端点） ---------------- */
  'POST /api/auth/register': async (req, res) => {
    const body = await readJsonBody(req);
    const phone = normalizePhone(body.phone);
    const password = String(body.password ?? '');
    if (!phone) return sendError(res, 400, '请输入正确的 11 位手机号');
    if (password.length < 6) return sendError(res, 400, '密码至少 6 位');
    if (findUserByPhone(db, phone)) return sendError(res, 409, '该手机号已注册，请直接登录');
    const user = createUser(db, { phone, password, welcomeCredits: Math.max(0, Number(process.env.WELCOME_CREDITS ?? 0)) });
    const { sid, expiresAt } = createUserSession(db, user.id);
    setSessionCookie(req, res, sid, (expiresAt - Date.now()) / 1000);
    saveDb();
    console.log('[auth] 注册 ' + phone.slice(0,3) + '****' + phone.slice(-4));
    sendJson(res, 201, { authenticated: true, user: publicUser(user), expiresAt: new Date(expiresAt).toISOString() });
  },

  'POST /api/auth/login': async (req, res) => {
    const ip = clientIp(req);
    const wait = loginBlocked(ip);
    if (wait) return sendError(res, 429, '尝试过于频繁，请 ' + wait + 's 后再试', { retryAfter: wait });
    const body = await readJsonBody(req);
    const phone = normalizePhone(body.phone);
    const password = String(body.password ?? '');
    if (!phone || !password) return sendError(res, 400, '请输入手机号和密码');
    const user = findUserByPhone(db, phone);
    if (!user || !checkPassword(user, password)) { noteLoginFail(ip); return sendError(res, 401, '手机号或密码不正确'); }
    if (user.status !== 'active') return sendError(res, 403, '账号已被停用');
    loginFails.delete(ip);
    user.lastLoginAt = new Date().toISOString();
    const { sid, expiresAt } = createUserSession(db, user.id);
    setSessionCookie(req, res, sid, (expiresAt - Date.now()) / 1000);
    saveDb();
    console.log('[auth] 登录 ' + phone.slice(0,3) + '****' + phone.slice(-4) + '，积分 ' + user.credits);
    sendJson(res, 200, { authenticated: true, user: publicUser(user), expiresAt: new Date(expiresAt).toISOString() });
  },

  'GET /api/me': async (req, res) => {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '未登录');
    sendJson(res, 200, { user: publicUser(user) });
  },

  'POST /api/credits/redeem': async (req, res) => {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '未登录');
    const body = await readJsonBody(req);
    const r = redeemCode(db, user, body.code);
    if (!r.ok) return sendError(res, 400, r.error);
    saveDb();
    sendJson(res, 200, { credits: r.credits, balance: r.balance, user: publicUser(user) });
  },

  'POST /api/admin/codes': async (req, res) => {
    const user = currentUser(req);
    if (!user || user.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const body = await readJsonBody(req);
    const codes = createCodes(db, { count: body.count, credits: body.credits, createdBy: user.id });
    saveDb();
    sendJson(res, 201, { codes });
  },


  'GET /api/auth/session': async (req, res) => {
    const session = currentSession(req);
    if (!session) {
      setSessionCookie(req, res, '', 0);
      return sendJson(res, 200, {
        authenticated: false,
        expiresAt: new Date(endOfSessionDay()).toISOString(),
        sessionEndMinutes: SESSION_END_MINUTE,
      });
    }
    sendJson(res, 200, {
      authenticated: true,
      user: publicUser(session.userId ? db.users[session.userId] : null),
      expiresAt: new Date(session.expiresAt).toISOString(),
      sessionEndMinutes: SESSION_END_MINUTE,
      createdAt: session.createdAt,
    });
  },

  'POST /api/auth/logout': async (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid && db.sessions[sid]) {
      delete db.sessions[sid];
      saveDb();
    }
    setSessionCookie(req, res, '', 0);
    console.log('[auth] 已退出登录');
    sendJson(res, 200, { authenticated: false });
  },

  /* ---------------- 维护：手动触发过期清理（便于联调） ---------------- */
  'POST /api/maintenance/sweep': async (req, res) => {
    const result = await sweepExpired('manual');
    sendJson(res, 200, { swept: result, ttlHours: UPLOAD_TTL_MS / 3600000 });
  },

  'POST /api/uploads': handleUpload,

  /** 秒传预检：先问「这个 MD5 你有没有」，有就不传了 */
  'POST /api/uploads/precheck': handlePrecheck,

  /** 发起处理：返回 taskId */
  'POST /api/files/:id/process': async (req, res, { params }) => {
    const file = db.files[params.id];
    if (!file) return sendError(res, 404, '文件不存在');
    if (isFileExpired(file)) {
      return sendError(res, 410, `源文件已过期（超过 ${ttlHours()} 小时）并被删除，请重新上传`, { expiresAt: new Date(fileExpiresAt(file)).toISOString() });
    }
    // 去字幕必须走指定的接口：没配好就直接拒绝，不做任何本地替代
    if (!eraseApi.ready) {
      // 面向使用者的说明保持人话；技术细节只留在服务端日志与 missing 字段里
      return sendError(res, 503, '去字幕服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint,
        missing: eraseApi.missing,
      });
    }

    const body = await readJsonBody(req);
    const operation = body.operation || DEFAULT_OPERATION;
    if (!OPERATIONS[operation]) return sendError(res, 400, `未知的处理类型 ${operation}`, { allowed: Object.keys(OPERATIONS) });

    // 客户端会带上原片时长（预览元素已经知道），用来估算总耗时、把进度条驱动得可信
    const task = createTaskForFile(file, { operation, durationSec: body.durationSec });
    enqueue(task.id);
    console.log(`[task] ${task.id} 去字幕 <- ${file.id}`);
    sendJson(res, 202, { task: serializeTask(task), poll: `/api/tasks/${task.id}` });
  },

  /**
   * 建批次：一次提交一批文件（≤ MAX_BATCH_SIZE）。
   * 只建任务记录，不立刻开始 —— 具体哪些任务开始，由「全部开始」或单行「开始任务」决定。
   */
  'POST /api/batches': async (req, res) => {
    if (!eraseApi.ready) {
      return sendError(res, 503, '去字幕服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    const diskCheck = diskGuard();
    if (!diskCheck.ok) {
      return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
    }
    const body = await readJsonBody(req);
    // 注意：这里不去重 —— 用户选了 4 个文件就要有 4 行。
    // 「内容相同的行」由 createBatch 按 MD5 合并成同一个任务，并在该行标记 shared（界面显示"已跳过·复用"）。
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((x) => typeof x === 'string') : [];
    if (!fileIds.length) return sendError(res, 400, '请至少选择一个文件');
    if (fileIds.length > MAX_BATCH_SIZE) {
      return sendError(res, 400, `一批最多 ${MAX_BATCH_SIZE} 个文件（当前 ${fileIds.length} 个）`, { maxBatchSize: MAX_BATCH_SIZE });
    }
    const operation = body.operation || DEFAULT_OPERATION;
    if (!OPERATIONS[operation]) return sendError(res, 400, `未知的处理类型 ${operation}`, { allowed: Object.keys(OPERATIONS) });

    const files = [];
    for (const fid of fileIds) {
      const file = db.files[fid];
      if (!file) return sendError(res, 404, `文件不存在或已被清理：${fid}`);
      if (isFileExpired(file)) return sendError(res, 410, `源文件已过期：${file.name}`, { fileId: fid });
      files.push(file);
    }

    // 磁盘预判：产物约为源文件的 DISK_OUTPUT_FACTOR 倍，留出安全余量
    // 磁盘预估按"唯一内容"算（同一个文件被选多次不该重复占用）
    const inputBytes = [...new Map(files.map((f) => [f.md5, f])).values()].reduce((a, f) => a + (f.size || 0), 0);
    const needBytes = Math.round(inputBytes * DISK_OUTPUT_FACTOR);
    const free = freeDiskBytes();
    if (free !== null && free < needBytes + DISK_RESERVE_BYTES) {
      return sendError(res, 507, '服务器磁盘空间不足，无法接收这批任务', {
        needBytes, freeBytes: free, reserveBytes: DISK_RESERVE_BYTES,
      });
    }

    const batch = createBatch({
    userId: currentUser(req)?.id || null, fileIds, operation, durations: body.durations || {}, erasePreset: body.erasePreset, eraseRegion: body.eraseRegion, eraseMode: body.eraseMode, modelVersion: body.modelVersion });
    sendJson(res, 202, { ...serializeBatch(batch), poll: `/api/batches/${batch.id}` });
  },

  'GET /api/batches/:id': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    sendJson(res, 200, { ...serializeBatch(batch), poll: `/api/batches/${batch.id}` });
  },

  /** 分批添加：往已有批次里追加文件（内容相同的行会复用批次内已有的任务） */
  'POST /api/batches/:id/items': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    if (!eraseApi.ready) {
      return sendError(res, 503, '去字幕服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    const diskCheck = diskGuard();
    if (!diskCheck.ok) {
      return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
    }
    const body = await readJsonBody(req);
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((x) => typeof x === 'string') : [];
    if (!fileIds.length) return sendError(res, 400, '没有要追加的文件');
    if (batch.items.length + fileIds.length > MAX_BATCH_SIZE) {
      return sendError(res, 400, `一批最多 ${MAX_BATCH_SIZE} 个文件（已有 ${batch.items.length} 个，本次 ${fileIds.length} 个）`, { maxBatchSize: MAX_BATCH_SIZE });
    }
    const files = [];
    for (const fid of fileIds) {
      const file = db.files[fid];
      if (!file) return sendError(res, 404, `文件不存在或已被清理：${fid}`);
      if (isFileExpired(file)) return sendError(res, 410, `源文件已过期：${file.name}`, { fileId: fid });
      files.push(file);
    }
    const inputBytes = [...new Map(files.map((f) => [f.md5, f])).values()].reduce((a, f) => a + (f.size || 0), 0);
    const needBytes = Math.round(inputBytes * DISK_OUTPUT_FACTOR);
    const free = freeDiskBytes();
    if (free !== null && free < needBytes + DISK_RESERVE_BYTES) {
      return sendError(res, 507, '服务器磁盘空间不足，无法接收这批任务', { needBytes, freeBytes: free, reserveBytes: DISK_RESERVE_BYTES });
    }
    const added = appendFilesToBatch(batch, fileIds, body.durations || {}, { erasePreset: body.erasePreset || batch.erasePreset, eraseRegion: body.eraseRegion, eraseMode: body.eraseMode, modelVersion: body.modelVersion });
    saveDb();
    console.log(`[batch] ${batch.id} 追加 ${added.length} 个文件（其中 ${added.filter((a) => a.shared).length} 个复用已有任务），现共 ${batch.items.length} 个`);
    sendJson(res, 202, { added: added.length, ...serializeBatch(batch), poll: `/api/batches/${batch.id}` });
  },

  /** 修改这一批的擦除区域：只影响还没开始（pending）的任务；已在跑的不动 */
  'PATCH /api/batches/:id': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const body = await readJsonBody(req).catch(() => ({}));
    const presetGiven = body.erasePreset !== undefined;
    if (presetGiven && !ERASE_PRESET_KEYS.includes(String(body.erasePreset))) {
      return sendError(res, 400, `未知的处理模式 ${body.erasePreset}`, { allowed: ERASE_PRESET_KEYS });
    }
    const key = String(body.eraseRegion || 'auto');
    if (body.eraseRegion !== undefined && !Object.prototype.hasOwnProperty.call(ERASE_REGIONS, key)) {
      return sendError(res, 400, `未知的擦除区域 ${key}`, { allowed: Object.keys(ERASE_REGIONS) });
    }
    const mode = body.eraseMode === undefined ? null : resolveEraseMode(body.eraseMode);
    const model = body.modelVersion === undefined ? null : resolveModelVersion(body.modelVersion);
    if (body.eraseMode !== undefined && !ERASE_MODES.includes(String(body.eraseMode))) {
      return sendError(res, 400, `未知的擦除模式 ${body.eraseMode}`, { allowed: ERASE_MODES });
    }
    const nextPreset = presetGiven ? resolveErasePreset(body.erasePreset) : resolveErasePreset(batch.erasePreset);
    const eff = applyErasePreset({
      preset: nextPreset,
      region: body.eraseRegion === undefined ? undefined : key,
      mode: body.eraseMode === undefined ? undefined : body.eraseMode,
      model: body.modelVersion === undefined ? undefined : body.modelVersion,
    });
    batch.erasePreset = eff.preset;
    if (body.eraseRegion !== undefined) batch.eraseRegion = key;
    if (mode) batch.eraseMode = mode;
    let updated = 0;
    let running = 0;
    for (const item of batch.items) {
      const t = db.tasks[item.taskId];
      if (!t) continue;
      if (t.status === 'processing') { running += 1; continue; }
      t.eraseRatioLocation = eff.region;
      t.mode = eff.mode;
      t.modelVersion = eff.model;
      t.erasePreset = eff.preset;
      if (t.status === 'pending') updated += 1;
    }
    saveDb();
    console.log(`[batch] ${batch.id} 擦除区域改为 ${key}（更新 ${updated} 个待开始任务${running ? `，${running} 个进行中不变` : ''}）`);
    sendJson(res, 200, { updated, running, ...serializeBatch(batch) });
  },

  /** 全部开始：把这一批里"未开始 / 失败 / 已取消"的任务一起排队 */
  'POST /api/batches/:id/start': async (req, res, { params }) => {
    if (!eraseApi.ready) {
      return sendError(res, 503, '去字幕服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const body = await readJsonBody(req).catch(() => ({}));
    const diskCheck = diskGuard();
    if (!diskCheck.ok) {
      return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
    }
    const picked = pickedIndexes(req, body, batch.items.length);
    const insufficient = [];
    let started = 0;
    for (const idx of picked) {

    // 扣费：1 秒 = 1 积分，幂等（同一任务只扣一次）
    const me = currentUser(req);
      const tid = batch.items[idx]?.taskId;
      const task = db.tasks[tid];
      if (!task || task.status === 'processing' || task.status === 'succeeded') continue;
      if (me && !task.chargedCredits) {
        const cr = chargeSeconds(db, me, task.durationSec || 1, task.id);
        if (!cr.ok) { insufficient.push(task.fileName || task.id); continue; }
        task.chargedCredits = cr.cost;
        task.userId = task.userId || me.id;
      }
      task.status = 'pending';
      task.progress = 0;
      task.stage = '等待开始';
      task.error = null;
      task.canceled = false;
      task.elapsedSeconds = 0;
      task.etaSeconds = task.estimatedSeconds ?? null;
      task.startedAt = null;
      task.finishedAt = null;
      delete task.resume;
      enqueue(task.id);
      started += 1;
    }
    saveDb();
    console.log(`[batch] ${batch.id} 批量开始：勾选 ${picked.length} 行 → 排队 ${started} 个任务`);
    sendJson(res, 202, {
      started, insufficient, poll: `/api/batches/${batch.id}`,
      ...(insufficient.length ? { error: `积分不足，${insufficient.length} 个未开始（需要 ${insufficient.length && insufficient.length} 积分）` } : {}),
      ...serializeBatch(batch),
    });
  },

/**
   * 清理一个上传文件（用于"还没建批次就移除"的行）：
   * 只有没有任何批次行/任务引用它时才允许，免得删掉别人正在用的源文件。
   */
  'DELETE /api/files/:id': async (req, res, { params }) => {
    const file = db.files[params.id];
    if (!file) return sendError(res, 404, '文件不存在');
    const purge = await purgeContent({ fileId: file.id });
    if (!purge.removedFile) return sendError(res, 409, purge.keptFile || '该文件仍被使用，暂不能清理');
    saveDb();
    console.log(`[file] ${file.name} (${file.id}) 已清理${purge.removedMd5 ? '（含 MD5 索引）' : ''}，释放 ${formatBytes(purge.freedBytes)}`);
    sendJson(res, 200, purge);
  },

/**
   * 批量删除批次里的若干行（勾选后一次删掉）：与单行「移除任务」同样**彻底清理**
   *   —— 源文件 + 产物 + db.files + db.md5Index + db.results + 产物目录 + 行引用
   * 只要勾选的行里有正在处理的任务，就整体拒绝（避免删掉云端正在读取的源文件）。
   */
  'DELETE /api/batches/:id/items': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const body = await readJsonBody(req).catch(() => ({}));
    const indexes = pickedIndexes(req, body, batch.items.length);
    const picked = indexes.filter((i) => batch.items[i]);
    if (!picked.length) return sendError(res, 400, '没有要删除的任务');

    const blocked = picked.filter((i) => {
      const t = db.tasks[batch.items[i].taskId];
      return t && t.status === 'processing';
    });
    if (blocked.length) {
      return sendError(res, 409, `勾选的任务里有 ${blocked.length} 个正在处理中，请先停止后再删除`, {
        blocked: blocked.map((i) => i + 1),
      });
    }

    const done = { removed: 0, removedFiles: 0, removedTasks: 0, removedMd5: 0, freedBytes: 0, kept: [] };
    // 倒序删除：行号不会因为前面的行被删掉而错位
    for (const idx of [...picked].sort((a, b) => b - a)) {
      const item = batch.items[idx];
      if (!item) continue;
      batch.items.splice(idx, 1);
      const purge = await purgeContent({ fileId: item.fileId, taskId: item.taskId });
      if (item.taskId) batch.taskIds = (batch.taskIds || []).filter((t) => t !== item.taskId);
      done.removed += 1;
      if (purge.removedFile) done.removedFiles += 1;
      if (purge.removedTask) done.removedTasks += 1;
      if (purge.removedMd5) done.removedMd5 += 1;
      done.freedBytes += purge.freedBytes;
      if (purge.keptFile || purge.keptTask) {
        done.kept.push({ row: idx + 1, reason: [purge.keptFile, purge.keptTask].filter(Boolean).join('；') });
      }
    }
    saveDb();
    console.log(
      `[batch] ${batch.id} 批量删除 ${done.removed} 行 → 源文件 ${done.removedFiles} 个、产物 ${done.removedTasks} 个、` +
      `MD5 索引 ${done.removedMd5} 条，释放 ${formatBytes(done.freedBytes)}` +
      (done.kept.length ? `；${done.kept.length} 行因仍被引用而保留` : ''),
    );
    sendJson(res, 200, { ...done, ...serializeBatch(batch) });
  },

      /**
   * 移除批次里的一行（按行号定位，避免同一文件被选多次时歧义）。
   * 规则：处理中的任务不能移除；未开始 / 已完成 / 失败 都可以移除。
   * 若该行引用的任务不再被其它行复用，则连带删除任务记录与产出的产物文件（释放磁盘）。
   */
  'DELETE /api/batches/:batchId/items/:index': async (req, res, { params }) => {
    const batch = db.batches?.[params.batchId];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const idx = Number(params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= batch.items.length) {
      return sendError(res, 400, '行号无效');
    }
    const item = batch.items[idx];
    const task = item.taskId ? db.tasks[item.taskId] : null;
    if (task && task.status === 'processing') {
      return sendError(res, 409, '任务正在处理中，不能移除（可先停止任务）');
    }
batch.items.splice(idx, 1);
      // 彻底清理：源文件 + 产物 + MD5 索引 + 内容索引（若仍被其它行引用则保留）
      const purge = await purgeContent({ fileId: item.fileId, taskId: item.taskId });
      if (task) batch.taskIds = (batch.taskIds || []).filter((t) => t !== task.id);
      saveDb();
      console.log(
        `[batch] ${batch.id} 移除第 ${idx + 1} 行 → 源文件${purge.removedFile ? '已删' : '保留'}` +
        `、产物${purge.removedTask ? '已删' : '保留'}${purge.removedMd5 ? '、MD5 索引已删' : ''}，释放 ${formatBytes(purge.freedBytes)}`,
      );
      sendJson(res, 200, { ...purge, ...serializeBatch(batch) });
  },

  /** 全部取消：停掉这一批里进行中的任务；未提交到接口的直接回到"待开始" */
  'DELETE /api/batches/:id': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const body = await readJsonBody(req).catch(() => ({}));
    const picked = pickedIndexes(req, body, batch.items.length);
    // 先把"正在处理"的挑出来，云端终止请求稍后放后台发（不让界面干等）
    const running = picked
      .map((idx) => db.tasks[batch.items[idx]?.taskId])
      .filter((t) => t && t.status === 'processing');
    let canceled = 0;
    let reset = 0;
    for (const idx of picked) {
      const tid = batch.items[idx]?.taskId;
      const task = db.tasks[tid];
      if (!task || (task.status !== 'pending' && task.status !== 'processing')) continue;
      if (task.status === 'processing') {
        task.canceled = true;
        task.status = 'canceled';
        task.stage = task.remoteCancel?.ok ? '已取消（云端已终止）' : '已取消';
        task.finishedAt = new Date().toISOString();
        canceled += 1;
      } else {
        task.stage = '等待开始';   // 还没开始的，取消等于不排它
        reset += 1;
      }
    }
    saveDb();
    console.log(`[batch] ${batch.id} 批量取消：勾选 ${picked.length} 行 → 停止 ${canceled} 个进行中任务，重置 ${reset} 个未开始任务`);
    // 先回响应（界面立刻变"已取消"），云端终止请求随后在后台发出
    sendJson(res, 200, { cancel: { background: running.length > 0 }, ...serializeBatch(batch), poll: `/api/batches/${batch.id}` });
    if (running.length) {
      cancelTasks(running).then(() => {
        for (const t of running) {
          const now = db.tasks[t.id];
          if (now && now.remoteCancel?.ok) now.stage = '已取消（云端已终止）';
        }
        saveDb();
      }).catch(() => {});
    }
  },

  /** 单任务「开始任务」：把失败/已取消/未开始的任务重新排队（已完成需 force） */
  'POST /api/tasks/:id/start': async (req, res, { params }) => {
    if (!eraseApi.ready) {
      return sendError(res, 503, '去字幕服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    const task = db.tasks[params.id];
    if (!task) return sendError(res, 404, '任务不存在');
    const diskCheck = diskGuard();
    if (!diskCheck.ok) {
      return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
    }
    if (task.status === 'processing') return sendError(res, 409, '任务正在处理中');
    const body = await readJsonBody(req).catch(() => ({}));
    if (task.status === 'succeeded' && !body.force) {
      return sendError(res, 409, '任务已完成；如需重新处理请传 force: true', { status: task.status });
    }
    task.status = 'pending';
    task.progress = 0;
    task.stage = '等待开始';
    task.error = null;
    task.canceled = false;
    task.elapsedSeconds = 0;
    task.etaSeconds = task.estimatedSeconds ?? null;
    task.startedAt = null;
    task.finishedAt = null;
    delete task.resume;
    saveDb();
    enqueue(task.id);
    console.log(`[task] ${task.id} 手动开始`);
    sendJson(res, 202, { task: serializeTask(task) });
  },

  'GET /api/tasks/:id': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (!task) return sendError(res, 404, '任务不存在');
    sendJson(res, 200, { task: serializeTask(task), poll: `/api/tasks/${task.id}` });
  },

  'DELETE /api/tasks/:id': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (!task) return sendError(res, 404, '任务不存在');
    if (task.status === 'pending' || task.status === 'processing') {
      const wasProcessing = task.status === 'processing';
      // ① 本地立刻生效：状态与界面马上变"已取消"
      //   （之前同步等云端两次尝试、最长十几秒才响应，界面像卡死 → 用户以为取消不掉）
      task.canceled = true;
      task.status = 'canceled';
      task.stage = '已取消';
      task.stageKey = 'canceled';
      task.finishedAt = new Date().toISOString();
      saveDb();
      sendJson(res, 200, { task: serializeTask(task), cancel: { background: wasProcessing } });
      // ② 云端终止请求一定发出去，但放后台（官方目前无此接口，结果如实记录，稍后轮询能看到）
      if (wasProcessing) {
        cancelTasks([task]).then(() => {
          const t = db.tasks[task.id];
          if (t && t.remoteCancel?.ok) { t.stage = '已取消（云端已终止）'; saveDb(); }
        }).catch(() => {});
      }
      return;
    }
    sendJson(res, 200, { task: serializeTask(task), cancel: null });
  },

  'GET /api/download/:id': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (!task) return sendError(res, 404, '任务不存在');
    if (task.status === 'expired' && !(task.result?.remote && remoteAlive(task))) {
      return sendError(res, 410, '源文件已过期，产物已删除，请重新上传处理');
    }
    if (task.status !== 'succeeded' && task.status !== 'expired') {
      return sendError(res, 409, '任务尚未完成', { status: task.status });
    }

    const outExt = OPERATIONS[task.operation].outputExt;
    if (task.result.hasVideo && task.result.remote && remoteAlive(task)) {
      res.writeHead(302, { Location: task.remoteResultUrl, 'Cache-Control': 'no-store' });
      return res.end();
    }
    const target = task.result.hasVideo
      ? path.join(OUTPUT_DIR, task.id, `output${outExt}`)
      : path.join(OUTPUT_DIR, task.id, 'poster.svg');
    serveFile(req, res, target, {
      downloadName: task.result.name,
      mime: task.result.hasVideo ? MIME[outExt] || 'video/mp4' : 'image/svg+xml',
    });
  },

  'GET /api/artifacts/:id/:name': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (task && task.status === 'expired' && !(task.result?.remote && remoteAlive(task))) {
      return sendError(res, 410, '源文件已过期，产物已删除');
    }
    if (!task || task.status !== 'succeeded') return sendError(res, 404, '产物不存在');
    const outExt = OPERATIONS[task.operation].outputExt;
    const map = { 'poster.svg': 'poster.svg', video: 'output' + outExt };
    const key = params.name === 'video' ? 'video' : params.name;
    const fileName = map[key];
    if (!fileName) return sendError(res, 404, '产物不存在');
    if (key === 'video' && task.result?.remote && remoteAlive(task)) {
      res.writeHead(302, { Location: task.remoteResultUrl, 'Cache-Control': 'no-store' });
      return res.end();
    }
    serveFile(req, res, path.join(OUTPUT_DIR, task.id, fileName), { cache: 'public, max-age=31536000, immutable' });
  },

  /** 公开访问 URL：/f/:id —— 按文件的唯一 ID 访问，去字幕接口就是拉这里 */
  'GET /f/:id': async (req, res, { params }) => {
    const file = findFileByKey(params.id);
    if (!file) return sendError(res, 404, '文件不存在或已过期');
    if (isFileExpired(file)) {
      return sendError(res, 410, `文件已过期（超过 ${ttlHours()} 小时）并被删除，请重新上传`, { expiresAt: new Date(fileExpiresAt(file)).toISOString() });
    }
    // 内联返回，供页面预览（支持 Range）；产物下载走 /api/download/:taskId
    // ?dl=1 → 当下载处理（带真实文件名），用于"浏览器放不了这个格式"时的兜底
    const asDownload = new URL(req.url, 'http://x').searchParams.get('dl') === '1';
    serveFile(req, res, path.join(DATA_DIR, file.storedPath), {
      mime: MIME[file.ext] || file.mime,
      downloadName: asDownload ? file.name : undefined,
    });
  },
};

const STATIC_ROUTES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/md5.js': ['md5.js', 'text/javascript; charset=utf-8'],
  '/local-eraser.js': ['local-eraser.js', 'text/javascript; charset=utf-8'],
  '/md5-worker.js': ['md5-worker.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function matchRoute(method, pathname) {
  // HEAD 与 GET 同路由：探测可达性、取元信息都靠它（返回头但不返回 body）
  const verb = method === 'HEAD' ? 'GET' : method;
  const direct = ROUTES[`${verb} ${pathname}`];
  if (direct) return { handler: direct, params: {} };
  for (const key of Object.keys(ROUTES)) {
    const [m, pattern] = key.split(' ');
    if (m !== verb) continue;
    const pk = pattern.split('/');
    const ak = pathname.split('/');
    if (pk.length !== ak.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pk.length; i += 1) {
      if (pk[i].startsWith(':')) params[pk[i].slice(1)] = decodeURIComponent(ak[i]);
      else if (pk[i] !== ak[i]) { ok = false; break; }
    }
    if (ok) return { handler: ROUTES[key], params };
  }
  return null;
}

/** 无需登录即可访问的接口（登录本身，以及让未登录页面判断会话状态） */
const PUBLIC_ROUTES = new Set([
  'POST /api/auth/login',
  'POST /api/auth/register',
  'GET /api/auth/session',
  'POST /api/auth/logout',
]);

// ---------------------------------------------------------------- 服务器
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.on('finish', () => {
    if (!url.pathname.startsWith('/api/tasks/') || res.statusCode >= 400) {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,x-file-name,x-file-md5,range',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  // 静态资源
  const staticEntry = STATIC_ROUTES[url.pathname];
  if (staticEntry && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveFile(req, res, path.join(PUBLIC_DIR, staticEntry[0]), { mime: staticEntry[1], cache: 'no-cache' });
  }

  const route = matchRoute(req.method, url.pathname);
  if (!route) return sendError(res, 404, `无此接口: ${req.method} ${url.pathname}`);

  // ---- 鉴权：除登录相关接口与「能力 URL」外，全部要求有效会话 ----
  // 公开的只有 /f/<vf_xxx>：16 字节随机 ID，属于不可猜测的 capability URL，
  // 供云端去字幕服务匿名拉取源文件；/f/<md5> 可被推算，因此必须登录。
  // 允许 GET 与 HEAD：云端/CDN 常常先用 HEAD 探测可达性，只放行 GET 会把它们挡在 401 外
  const capabilityUrl =
    (req.method === 'GET' || req.method === 'HEAD') && /^\/f\/vf_[A-Za-z0-9_-]+$/.test(url.pathname);
  const authless = PUBLIC_ROUTES.has(`${req.method} ${url.pathname}`) || capabilityUrl;

  // 归属校验：批次/任务必须属于当前用户（管理员例外，历史无主数据放行）
  if (!authless) {
    const me = currentUser(req);
    if (me && me.role !== 'admin') {
      const mB = /^\/api\/batches\/([^/]+)/.exec(url.pathname);
      const mT = /^\/api\/(?:tasks|download|artifacts)\/([^/]+)/.exec(url.pathname);
      const owner = mB ? db.batches[mB[1]] : mT ? db.tasks[mT[1]] : null;
      if (owner && owner.userId && owner.userId !== me.id) {
        return sendError(res, 404, '资源不存在');
      }
    }
  }

  if (!authless && !currentSession(req)) {
    // 便于排查「莫名掉登录」：记录是否携带了 Cookie
    console.warn(`[auth] 401 ${req.method} ${url.pathname} cookie=${req.headers.cookie ? `已携带(${String(req.headers.cookie).slice(0, 40)}…)` : '未携带'}`);
    if (req.method === 'HEAD') {
      res.writeHead(401, { 'www-authenticate': 'Cookie', 'cache-control': 'no-store' });
      return res.end();
    }
    return sendError(res, 401, '未登录或会话已过期（每天 23:59 失效），请重新输入访问 Token', {
      login: '/api/auth/login',
      sessionEndMinutes: SESSION_END_MINUTE,
    });
  }

  res.isHead = req.method === 'HEAD';
  try {
    await route.handler(req, res, { params: route.params, url });
  } catch (err) {
    console.error(`[error] ${req.method} ${url.pathname}`, err);
    if (!res.headersSent) sendError(res, err.status || 500, err.message || '服务器内部错误');
  }
});

try {
  const admin = ensureAdmin(db, { phone: normalizePhone(process.env.ADMIN_PHONE), password: process.env.ADMIN_PASSWORD });
  if (admin) saveDb();
} catch (err) { console.warn('[accounts]', err.message); }

server.listen(PORT, HOST, async () => {
  // 先接管/清理上次运行遗留的「处理中」任务，再开始服务
  recoverInterruptedTasks();
  const swept = await sweepExpired('startup').catch((err) => {
    console.error('[ttl] 启动清理失败:', err.message);
    return { removed: 0 };
  });
  pruneSessions();
  const sessionEndsAt = new Date(endOfSessionDay());
  console.log(`\n  ClipFlow · 全自动视频去字幕`);
  console.log(`  本机       http://127.0.0.1:${PORT}`);
  console.log(`  外部       ${baseUrl()}   (能力 URL ${baseUrl()}/f/vf_<id>)`);
  console.log(`  数据       ${DATA_DIR}`);
  console.log(`  登录       Token 来源：${ACCESS_TOKEN.source}`);
  if (ACCESS_TOKEN.source.startsWith('自动生成')) {
    console.log(`             Token = ${ACCESS_TOKEN.token}`);
  }
  console.log(`             会话有效期至 ${sessionEndsAt.toLocaleString('zh-CN')}（此后需重新登录）`);
  console.log(`  去字幕接口 ${eraseApi.endpoint}`);
  console.log(
    eraseApi.ready
      ? `             密钥与公网入口均已配置，可以提交任务`
      : `             ⚠ 未配置完成，缺少：${eraseApi.missing.join('、')}（提交任务会被拒绝）`,
  );
  console.log(`  过期策略   源文件 ${UPLOAD_TTL_MS / 3600000} 小时后删除（含 MD5 索引），每 ${SWEEP_INTERVAL_MS / 1000}s 扫描一次`);
  if (swept.removed) console.log(`             启动时清理了 ${swept.removed} 个过期文件`);
  console.log(`  并发       同时在场 ${MAX_ACTIVE_TASKS} · 提交 ${SUBMIT_CONCURRENCY} · 回传 ${FETCH_CONCURRENCY}`);
  console.log(`  单文件上限 ${formatBytes(MAX_UPLOAD_BYTES)}`);
  console.log(`  版本       ${BUILD_ID}\n`);
});

// 定时清理过期文件（同时兜住跨天的会话失效）
setInterval(() => {
  sweepExpired('timer').catch((err) => console.error('[ttl] 定时清理失败:', err.message));
  pruneSessions();
}, SWEEP_INTERVAL_MS).unref?.();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，保存状态并退出`);
    saveDbSync();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
