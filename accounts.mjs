/**
 * 账号与积分（P1）
 * - 用户：手机号 + 密码（scrypt），为后续短信验证码 / 微信登录预留字段
 * - 积分：按秒计费（1 秒 = 1 积分），账本只追加，失败/取消全额退还
 * - 卡密：管理员生成，用户兑换入账
 * 全部为零依赖实现，数据放在 db.json 的 users / creditLedger / redemptionCodes 里。
 */
import crypto from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;   // 手机号+密码登录：30 天
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // 去掉易混字符

const nowIso = () => new Date().toISOString();
export const uid = (prefix = 'u') => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

/* ---------------------------------------------------------------- 手机号/密码 */
export function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;              // 大陆手机号
  return null;
}

function scrypt(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(String(password), salt, 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ---------------------------------------------------------------- 用户 */
export function findUserByPhone(db, phone) {
  return Object.values(db.users || {}).find((u) => u.phone === phone) || null;
}

export function createUser(db, { phone, password, role = 'user', welcomeCredits = 0 }) {
  const user = {
    id: uid('u'),
    phone,
    phoneVerifiedAt: null,
    password: scrypt(password),
    wechat: { openid: null, unionid: null, nickname: null, avatar: null },
    credits: 0,
    role,
    status: 'active',
    createdAt: nowIso(),
    lastLoginAt: null,
  };
  db.users ||= {};
  db.users[user.id] = user;
  if (welcomeCredits > 0) addCredits(db, user, welcomeCredits, 'welcome');
  return user;
}

export function checkPassword(user, password) {
  return !!user && verifyPassword(password, user.password);
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    phone: user.phone ? `${user.phone.slice(0, 3)}****${user.phone.slice(-4)}` : null,
    phoneFull: user.phone || null,
    credits: user.credits || 0,
    role: user.role,
    wechatBound: !!user.wechat?.unionid,
    createdAt: user.createdAt,
  };
}

/* ---------------------------------------------------------------- 会话 */
export function createUserSession(db, userId) {
  const sid = crypto.randomBytes(18).toString('base64url');
  db.sessions ||= {};
  db.sessions[sid] = { userId, createdAt: nowIso(), expiresAt: Date.now() + SESSION_TTL_MS };
  return { sid, expiresAt: db.sessions[sid].expiresAt };
}

/* ---------------------------------------------------------------- 积分账本 */
export function addLedger(db, user, delta, reason, extra = {}) {
  const entry = {
    id: uid('lg'),
    userId: user.id,
    delta,
    reason,
    balanceAfter: user.credits,
    at: nowIso(),
    ...extra,
  };
  db.creditLedger ||= [];
  db.creditLedger.push(entry);
  if (db.creditLedger.length > 20000) db.creditLedger = db.creditLedger.slice(-20000);
  return entry;
}

export function addCredits(db, user, amount, reason, extra) {
  const n = Math.floor(Number(amount) || 0);
  if (n <= 0) return null;
  user.credits = Math.floor(Number(user.credits) || 0) + n;
  return addLedger(db, user, n, reason, extra);
}

/** 按秒扣费：1 秒 = 1 积分。返回 {ok, need, cost} 或 {ok:false, need} */
export function chargeSeconds(db, user, seconds, taskId) {
  const cost = Math.max(1, Math.ceil(Number(seconds) || 0));   // 至少 1 积分
  if ((user.credits || 0) < cost) return { ok: false, need: cost, have: user.credits || 0 };
  user.credits -= cost;
  addLedger(db, user, -cost, `task:${taskId}`, { taskId, seconds: cost });
  return { ok: true, cost, balance: user.credits };
}

export function refundSeconds(db, user, cost, taskId, why = 'refund') {
  if (!user || !cost) return null;
  return addCredits(db, user, cost, why, { taskId });
}

/* ---------------------------------------------------------------- 卡密 */
function randomCode(len = 16) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `WM-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

export function createCodes(db, { count, credits, createdBy }) {
  const n = Math.min(200, Math.max(1, Math.floor(Number(count) || 1)));
  const c = Math.max(1, Math.floor(Number(credits) || 0));
  db.redemptionCodes ||= {};
  const made = [];
  for (let i = 0; i < n; i += 1) {
    let code;
    do { code = randomCode(); } while (db.redemptionCodes[code]);
    db.redemptionCodes[code] = {
      code, credits: c, createdBy, createdAt: nowIso(), usedBy: null, usedAt: null,
    };
    made.push(code);
  }
  return made;
}

export function redeemCode(db, user, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const rec = db.redemptionCodes?.[code];
  if (!rec) return { ok: false, error: '卡密不存在，请检查后重试' };
  if (rec.usedBy) return { ok: false, error: '这张卡密已经被使用过了' };
  if (user.status !== 'active') return { ok: false, error: '账号已被停用' };
  rec.usedBy = user.id;
  rec.usedAt = nowIso();
  const entry = addCredits(db, user, rec.credits, 'redeem', { code });
  return { ok: true, credits: rec.credits, balance: user.credits, entry };
}

/* ---------------------------------------------------------------- 初始化管理员 */
export function ensureAdmin(db, { phone, password }) {
  if (!phone || !password) return null;
  let user = findUserByPhone(db, phone);
  if (!user) {
    user = createUser(db, { phone, password, role: 'admin' });
    console.log(`[accounts] 已创建管理员账号 ${phone.slice(0, 3)}****${phone.slice(-4)}`);
  } else if (user.role !== 'admin') {
    user.role = 'admin';
  }
  return user;
}
