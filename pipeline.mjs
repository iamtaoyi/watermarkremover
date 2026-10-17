/**
 * 全自动视频去字幕 · 处理流水线
 * ------------------------------------------------------------------
 * 只走指定的去字幕接口（火山引擎 mediakit erase-video-subtitle-pro）：
 *
 *   POST {AMK_API_BASE}/tools/erase-video-subtitle-pro   { video_url, mode: "Subtitle" }
 *        -> { task_id }
 *   GET  {AMK_API_BASE}/tasks/{task_id}                  -> processing | succeeded | failed
 *        -> 成功时返回产物地址，服务端把它回传到本地供预览与下载
 *
 * 硬性前提：该接口是云端服务，必须能**匿名拉取** video_url，
 * 所以 video_url 用文件的能力 URL /f/<fileId>，并且要配好 PUBLIC_BASE_URL（隧道/域名）。
 *
 * 没有配置接口密钥或公网入口时：直接报错，不做任何本地替代实现，也不静默降级。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/* ------------------------------------------------------------ 处理类型 */
export const OPERATIONS = {
  'erase-subtitle': {
    id: 'erase-subtitle',
    label: '全自动去字幕',
    desc: '调用云端去字幕接口，逐帧擦除硬字幕',
    mode: 'Subtitle', // 传给去字幕接口的 mode 参数
    outputExt: '.mp4',
  },
};
export const DEFAULT_OPERATION = 'erase-subtitle';

/* ------------------------------------------------------------ 阶段定义
 * 权重和 = 100，前端进度条按此推进；'cloud' 阶段的实际进度优先取接口返回值，
 * 接口不返回进度时按时间平滑推进（见 runCloudErase）。
 */
export const STAGES = [
  { key: 'probe', label: '校验源文件与公网可达性', weight: 5 },
  { key: 'submit', label: '提交去字幕任务', weight: 5 },
  { key: 'cloud', label: '云端逐帧擦除字幕', weight: 70 },
  { key: 'fetch', label: '回传处理结果', weight: 15 },
  { key: 'finalize', label: '生成封面与校验和', weight: 5 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (obj, keys) => keys.map((k) => obj?.[k]).find((v) => v !== undefined && v !== null && v !== '');

/**
 * 去字幕接口的响应解包。
 * 注意：**不能**把顶层 result 当成信封——它是正常业务字段（产物地址就在 result.video_url），
 * 官方轮询响应形如 { success, task_id, task_type, status, result: { video_url, duration }, ... }。
 * 只把 data 视为可能的信封，字段在「信封内 → 根」两处依次查找。
 */
function unwrap(json) {
  const root = json && typeof json === 'object' ? json : {};
  const env = root.data && typeof root.data === 'object' ? root.data : root;
  const result = (env.result && typeof env.result === 'object' && env.result)
    || (root.result && typeof root.result === 'object' && root.result)
    || {};
  const field = (keys) => pick(env, keys) ?? pick(root, keys);
  return { root, env, result, field };
}

/** 官方状态取值：completed 表示成功；其余按 processing 处理，failed/error/expired 视为失败 */
const STATUS_DONE = ['completed', 'succeeded', 'success', 'done', 'finished'];
const STATUS_FAIL = ['failed', 'error', 'fail', 'expired', 'canceled'];
const OUT_KEYS = ['video_url', 'output_url', 'url', 'result_url', 'file_url'];

class TaskCanceled extends Error {
  constructor() {
    super('任务已被取消');
    this.code = 'CANCELED';
  }
}

/* ------------------------------------------------------------ 接口配置 */
export const AMK_DEFAULT_BASE = 'https://mediakit.cn-beijing.volces.com/api/v1';
export const AMK_DEFAULT_TOOL = '/tools/erase-video-subtitle-pro';

const apiBase = () => (process.env.AMK_API_BASE || AMK_DEFAULT_BASE).replace(/\/+$/, '');
const toolPath = () => process.env.AMK_TOOL_PATH || AMK_DEFAULT_TOOL;

/** 去字幕接口的配置状态，用于启动日志、/api/config 与清晰报错 */
export function eraseApiConfig() {
  const missing = [];
  if (!process.env.AMK_API_KEY) missing.push('AMK_API_KEY');
  if (!process.env.PUBLIC_BASE_URL) missing.push('PUBLIC_BASE_URL');
  return {
    endpoint: `${apiBase()}${toolPath()}`,
    pollUrl: `${apiBase()}/tasks/<task_id>`,
    keyConfigured: Boolean(process.env.AMK_API_KEY),
    publicBaseConfigured: Boolean(process.env.PUBLIC_BASE_URL),
    ready: missing.length === 0,
    missing,
  };
}

function apiHeaders() {
  const key = process.env.AMK_API_KEY;
  if (!key) throw new Error('未配置去字幕接口密钥（AMK_API_KEY），无法提交任务');
  const h = { 'content-type': 'application/json' };
  if (process.env.AMK_AUTH_HEADER === 'amk-api-key') h['amk-api-key'] = key;
  else h.authorization = `Bearer ${key}`;
  return h;
}

async function fetchJson(url, init = {}, timeoutMs = 30000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文用于报错 */
  }
  return { res, json, text };
}

/* ============================================================ 对外入口 */
/**
 * @param {object} task   任务记录（会就地更新：读取 task.canceled，写出 remoteTaskId）
 * @param {object} ctx    { srcPath, outDir, operation, mode, file, videoUrl }
 * @param {(p:{progress:number,stageKey:string,stage:string,message?:string})=>void} onProgress
 */
export async function runPipeline(task, ctx, onProgress) {
  const started = Date.now();
  const op = OPERATIONS[ctx.operation] || OPERATIONS[DEFAULT_OPERATION];
  await fs.mkdir(ctx.outDir, { recursive: true });

  const assertAlive = () => {
    if (task.canceled) throw new TaskCanceled();
  };

  /**
   * 两阶段闸门（由服务端注入）：
   *   submit —— 探测源文件 + 提交任务，很轻，可以并发多个
   *   fetch  —— 下载产物，很重（动辄上百 MB），必须限流
   * 轮询阶段不占闸门，只是一次很小的 GET。
   * 未注入时是直通，方便单测/命令行调试。
   */
  const gate = {
    submit: ctx.gate?.submit || ((fn) => fn()),
    fetch: ctx.gate?.fetch || ((fn) => fn()),
  };
  const gatedCtx = { ...ctx, gate };

  // 服务重启后接管：接口那边已经提交过（有 remoteTaskId），不再重复提交，只继续等待与回传
  const outcome = ctx.resume && task.remoteTaskId
    ? await resumeErase(task, gatedCtx, op, onProgress, assertAlive)
    : await runCloudErase(task, gatedCtx, op, onProgress, assertAlive);
  assertAlive();

  const videoOut = path.join(ctx.outDir, `output${op.outputExt}`);
  await writePoster(path.join(ctx.outDir, 'poster.svg'), { op, file: ctx.file, task });

  onProgress({ progress: 100, stageKey: 'done', stage: '去字幕完成' });
  return {
    durationMs: Date.now() - started,
    outputs: { video: videoOut, poster: path.join(ctx.outDir, 'poster.svg') },
    operation: op.id,
    remoteTaskId: outcome.remoteTaskId,
      // 不存副本模式：产物没落盘，大小来自 HEAD，地址在云端
      kept: outcome.kept,
      size: outcome.size,
      remoteUrl: outcome.remoteUrl,
  };
}

/* ------------------------------------------------------------ 去字幕接口调用 */
async function runCloudErase(task, ctx, op, onProgress, assertAlive) {
  const mode = ctx.mode || op.mode || 'Subtitle';
  const pollMs = Math.max(1000, Number(process.env.AMK_POLL_MS || 3000));

  // 1) 源文件可达性探测 + 2) 提交任务：放在 submit 闸门内（并发提交，等云端排队）
  const remoteTaskId = await ctx.gate.submit(async () => {
  onProgress({ progress: 2, stageKey: 'probe', stage: STAGES[0].label });
  if (!ctx.videoUrl) throw new Error('缺少可供去字幕接口拉取的 video_url');
  try {
    const head = await fetch(ctx.videoUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    if (!head.ok) throw new Error(`HTTP ${head.status}`);
  } catch (err) {
    throw new Error(
      `公网地址不可用（${ctx.videoUrl}）：${err.message}。` +
        '去字幕接口在公网侧，必须能直接匿名拉取该地址；请配置 PUBLIC_BASE_URL（反向代理域名或隧道）。',
    );
  }
  assertAlive();
  onProgress({ progress: 5, stageKey: 'probe', stage: '源文件可达，准备提交' });

  // 2) 提交任务，拿到 task_id
  onProgress({ progress: 6, stageKey: 'submit', stage: '正在提交去字幕任务' });
  assertAlive();   // 提交前最后确认：期间被取消就不提交，省一次云端调用
  const submit = await fetchJson(
    `${apiBase()}${toolPath()}`,
    {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          video_url: ctx.videoUrl,
          mode,
          // 擦除区域（可选）：字幕不在画面下方时用它覆盖到正确位置
          ...(ctx.eraseRatioLocation ? { erase_ratio_location: ctx.eraseRatioLocation } : {}),
          // 模型版本（可选）：v5.6 对移动水印 / 画面上部字幕效果更好
          ...(ctx.modelVersion ? { model_version: ctx.modelVersion } : {}),
        }),
      },
    30000,
  );
  if (!submit.res.ok) {
    const code = pick(submit.json?.error || {}, ['code']) || `HTTP ${submit.res.status}`;
    const msg = pick(submit.json?.error || {}, ['message']) || submit.text.slice(0, 200);
    throw new Error(`提交去字幕任务失败：${code} ${msg}`);
  }
  const submitBody = unwrap(submit.json);
  if (submitBody.root.success === false) {
    const code = pick(submitBody.root.error || {}, ['code']) || submitBody.field(['error_code', 'code']) || 'UnknownError';
    const msg = pick(submitBody.root.error || {}, ['message']) || submitBody.field(['error_message', 'message']) || submit.text.slice(0, 200);
    throw new Error(`提交去字幕任务被拒绝：${code} ${msg}`);
  }
  const remoteTaskId = submitBody.field(['task_id', 'taskId', 'id']);
  if (!remoteTaskId) throw new Error(`接口未返回 task_id：${submit.text.slice(0, 300)}`);
  // 立刻落库：万一之后服务重启，才能凭这个 id 继续接管，而不是丢掉整个任务
  ctx.setRemoteTaskId?.(remoteTaskId);
  task.remoteTaskId = String(remoteTaskId);
  console.log(`[erase] 已提交去字幕任务 task_id=${remoteTaskId} video_url=${ctx.videoUrl}`);
  onProgress({ progress: 10, stageKey: 'submit', stage: `任务已创建 ${remoteTaskId}` });
  return remoteTaskId;
  });                       // ← submit 闸门结束，之后轮询不占用提交名额
  assertAlive();

  return awaitCloudResult(remoteTaskId, task, ctx, op, onProgress, assertAlive, Date.now());
}

/** 接管一个已提交到接口的任务：只继续轮询与回传，不重复提交 */
export async function resumeErase(task, ctx, op, onProgress, assertAlive, cloudStart) {
  const elapsedMs = Math.max(0, Number(task.elapsedSeconds) || 0) * 1000;
  console.log(`[erase] 接管任务 ${task.remoteTaskId}（重启前已进行 ${Math.round(elapsedMs / 1000)}s）`);
  return awaitCloudResult(
    task.remoteTaskId, task, ctx, op, onProgress, assertAlive,
    cloudStart ?? Date.now() - elapsedMs,   // 回拨起点，已用/剩余时间跨重启保持连续
  );
}

/** 轮询到完成并把产物回传到本地（正常流程与重启接管共用） */
async function awaitCloudResult(remoteTaskId, task, ctx, op, onProgress, assertAlive, cloudStart) {
  const pollMs = Math.max(1000, Number(process.env.AMK_POLL_MS || 3000));
  let outputUrl = null;
  let lastRawLog = 0;
  let lastStatus = '';
  for (;;) {
    assertAlive();
    await sleep(pollMs);
    const r = await fetchJson(`${apiBase()}/tasks/${remoteTaskId}`, { headers: apiHeaders() }, 30000);
    if (!r.res.ok) {
      if (r.res.status === 404) throw new Error(`接口返回任务不存在（${remoteTaskId}）`);
      console.warn(`[erase] 轮询异常 HTTP ${r.res.status}，继续重试`);
      continue;
    }
    const body = unwrap(r.json);
    const rawStatus = body.field(['status', 'state', 'task_status']);
    if (rawStatus) lastStatus = String(rawStatus);
    const status = String(rawStatus || '').toLowerCase();

    // 状态字段读不出来就把原始响应打出来（每分钟一次），避免"静默卡住到超时"
    if (!rawStatus && Date.now() - lastRawLog > 60000) {
      lastRawLog = Date.now();
      console.warn(`[erase] 无法识别状态字段，原始响应：${r.text.slice(0, 600)}`);
    }
    const upstreamPct = Number(body.field(['progress', 'percent', 'percentage']));
    const elapsedSec = (Date.now() - cloudStart) / 1000;
    // 该接口不返回进度，只能用「预估总耗时」驱动：用 1-exp 曲线，全程都在动、且渐近到 93%
    const estimateSec = Number(task.estimatedSeconds) > 0
      ? Number(task.estimatedSeconds)
      : Number(process.env.AMK_FALLBACK_SECONDS || 900);
    const timeDriven = 12 + 81 * (1 - Math.exp(-elapsedSec / (estimateSec / 2.5)));
    const cloudPct = Number.isFinite(upstreamPct) && upstreamPct > 0
      ? Math.max(12, Math.min(93, upstreamPct * 0.82 + 10))
      : Math.min(93, timeDriven);
    const remainSec = estimateSec - elapsedSec;
    onProgress({
      progress: Math.round(cloudPct),
      stageKey: 'cloud',
      stage: '云端正在逐帧擦除字幕',
      // 只上报秒数：剩余时间由服务端算一次，前端两处展示共用同一个值，保证完全同步
      elapsedSeconds: Math.round(elapsedSec),
      etaSeconds: Math.max(0, Math.round(remainSec)),
    });

    if (STATUS_FAIL.includes(status)) {
      const code = pick(body.root.error || {}, ['code']) || body.field(['error_code', 'code']) || 'UnknownError';
      const msg = pick(body.root.error || {}, ['message']) || body.field(['error_message', 'message']) || r.text.slice(0, 300);
      if (/UrlDownloadFail|DownloadFileError/i.test(r.text)) {
        throw new Error(
          `接口无法下载源视频（${code}）。说明 video_url 不是公网可访问地址，` +
            '或返回的是 HTML / 需要鉴权的页面。请确认 PUBLIC_BASE_URL 已配置，且该地址能匿名 HEAD/GET 到视频字节。',
        );
      }
      throw new Error(`去字幕失败：${code} ${msg}`);
    }
    if (STATUS_DONE.includes(status)) {
      const outField = OUT_KEYS.find((k) => body.result[k]) || OUT_KEYS.find((k) => body.env[k]) || OUT_KEYS.find((k) => body.root[k]);
      outputUrl = body.result[outField] || body.env[outField] || body.root[outField];
      if (!outputUrl) throw new Error(`任务成功但没有返回产物地址：${r.text.slice(0, 300)}`);
      const outDuration = body.result.duration ? `，时长 ${body.result.duration}s` : '';
      console.log(`[erase] 任务成功（status=${status}），产物地址取自 result.${outField}${outDuration}`);
      void lastStatus;
      task.remoteResultUrl = outputUrl;
      break;
    }
    const elapsedMs = elapsedSec * 1000;
    if (elapsedMs > Number(process.env.AMK_TIMEOUT_MS || 30 * 60 * 1000)) {
      throw new Error(`去字幕任务超时（${Math.round(elapsedSec)}s）：${remoteTaskId}`);
    }
  }
  console.log(`[erase] 任务完成，开始回传产物 ${outputUrl}`);

  // 4) 回传产物：放进 fetch 闸门（下载上百 MB 很重，必须限流，避免批量时打满磁盘/带宽）
  await ctx.gate.fetch(async () => {
  // 不存副本模式：产物只留在云端。只做一次 HEAD 拿大小/校验可下载，
  // 浏览器在预览/下载时才会去云端取（不占服务器磁盘与带宽）。
  if (ctx.keepArtifact === false) {
    onProgress({ progress: 86, stageKey: 'fetch', stage: '正在确认处理结果' });
    let head = await fetch(outputUrl, { method: 'HEAD', signal: AbortSignal.timeout(60000) });
    if (head.status === 401 || head.status === 403) {
      head = await fetch(outputUrl, { method: 'HEAD', headers: apiHeaders(), signal: AbortSignal.timeout(60000) });
    }
    if (!head.ok) throw new Error(`确认处理结果失败：HTTP ${head.status}`);
    const remoteSize = Number(head.headers.get('content-length')) || 0;
    if (remoteSize && remoteSize < 1024) throw new Error(`处理结果过小（${remoteSize} B），可能不是视频`);
    ctx.remoteArtifact = { url: outputUrl, size: remoteSize };
    onProgress({ progress: 96, stageKey: 'fetch', stage: `产物已就绪（${formatBytes(remoteSize)}，保存在云端）` });
    return;
  }
  onProgress({ progress: 86, stageKey: 'fetch', stage: '正在下载处理结果' });
  const videoOut = path.join(ctx.outDir, `output${op.outputExt}`);
  const dlTimeout = Number(process.env.AMK_DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
  let dl = await fetch(outputUrl, { signal: AbortSignal.timeout(dlTimeout) });
  if (dl.status === 401 || dl.status === 403) {
    // 产物可能是私有地址：带上去字幕接口的鉴权头重试一次
    console.warn(`[erase] 产物地址返回 ${dl.status}，带鉴权头重试`);
    try { await dl.body?.cancel?.(); } catch { /* 忽略 */ }
    dl = await fetch(outputUrl, { headers: apiHeaders(), signal: AbortSignal.timeout(dlTimeout) });
  }
  if (!dl.ok) throw new Error(`下载处理结果失败：HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length < 1024) throw new Error(`处理结果过小（${buf.length} B），可能不是视频`);
  await fs.writeFile(videoOut, buf);
  onProgress({ progress: 96, stageKey: 'fetch', stage: `已回传 ${formatBytes(buf.length)}` });
  });                       // ← fetch 闸门结束

  return {
    remoteTaskId,
    kept: !ctx.remoteArtifact,
    size: ctx.remoteArtifact?.size || 0,
    remoteUrl: ctx.remoteArtifact?.url || null,
  };
}

/* ------------------------------------------------------------ 封面
 * 配色与站点（DSH 浅色主题）一致：#ffffff 底、#0f1115 主文字、#81858c 次级文字。
 */
export async function writePoster(dest, { op, file, task }) {
  const tint = parseInt(crypto.createHash('sha1').update(task.id).digest('hex').slice(0, 4), 16) % 8;
  const band = ['#f9fafb', '#f8f9fa', '#fafafa', '#f7f8f9', '#f9f9fb', '#f8f8fa', '#fafbfc', '#f7f8fa'][tint];
  const rawName = file?.name || 'video.mp4';
  const name = escapeXml(rawName.length > 30 ? `${rawName.slice(0, 29)}…` : rawName);
  const size = formatBytes(file?.size || 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#ffffff"/>
  <rect x="24" y="24" width="592" height="228" rx="14" fill="${band}" stroke="#0000001a"/>
  <g stroke="#0000000f" fill="none">
    <path d="M24 196 L616 168"/><path d="M24 222 L616 194"/>
  </g>
  <circle cx="320" cy="138" r="40" fill="#0f1115"/>
  <path d="M308 120 L342 138 L308 156 Z" fill="#ffffff"/>
  <text x="24" y="298" fill="#0f1115" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="20" font-weight="600">${name}</text>
  <text x="24" y="326" fill="#81858c" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="14">${escapeXml(op.label)} · ${size}</text>
  <text x="616" y="326" text-anchor="end" fill="#adb2b8" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="13">云端去字幕 · ClipFlow</text>
</svg>`;
  await fs.writeFile(dest, svg, 'utf8');
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** 秒 → 「X 分 Y 秒」 */
function fmtMinutes(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

/**
 * 尝试在云端终止一个已提交的任务。
 *
 * 现实情况（用真实 key 探测过）：AI MediaKit 官方目前**只有"提交任务 / 查询任务"两个接口**，
 * 没有取消接口 —— `POST /tasks/{id}/cancel` 等返回网关 404，`DELETE /tasks/{id}` 返回 405。
 * 所以这里做**尽力而为**的尝试：官方一旦补上该能力（返回 2xx），取消就真正作用到云端；
 * 现在则会退化成"停止本地跟踪"（不再轮询、不再下载产物），并把真实结果记录下来给界面展示。
 */
export async function cancelRemoteTask(remoteTaskId, { timeoutMs = 3000 } = {}) {
  const id = String(remoteTaskId || '').trim();
  if (!id) return { attempted: false, ok: false, note: '任务还没提交到接口，无需取消' };
  const tries = [
    { method: 'POST', url: `${apiBase()}/tasks/${encodeURIComponent(id)}/cancel` },
    { method: 'DELETE', url: `${apiBase()}/tasks/${encodeURIComponent(id)}` },
  ];
  let last = null;
  for (const t of tries) {
    try {
      const res = await fetch(t.url, { method: t.method, headers: apiHeaders(), signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text().catch(() => '');
      last = { method: t.method, path: `/tasks/${id}${t.method === 'POST' ? '/cancel' : ''}`, status: res.status, body: String(text).slice(0, 200) };
      console.log(`[erase] 取消尝试 ${t.method} ${last.path} → HTTP ${res.status}`);
      if (res.ok) {
        return { attempted: true, ok: true, status: res.status, at: new Date().toISOString(), note: '云端已接受取消请求', detail: last };
      }
    } catch (err) {
      last = { method: t.method, error: err.message };
      console.warn(`[erase] 取消尝试失败 ${t.method}：${err.message}`);
    }
  }
  return {
    attempted: true,
    ok: false,
    status: last?.status ?? null,
    at: new Date().toISOString(),
    note: '去字幕接口未提供取消能力（官方只有提交/查询），已停止本地跟踪；云端任务会自行结束，是否计费以云端为准',
    detail: last,
  };
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
