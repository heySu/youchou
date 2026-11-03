'use strict';
/**
 * 密码散列与访问令牌。
 * 不引入外部依赖：scrypt 做密码散列，HMAC-SHA256 做无状态令牌（结构同 JWT，仅两段）。
 */
const crypto = require('node:crypto');
const { db } = require('./db');

let SECRET = process.env.TOKEN_SECRET || null;
if (!SECRET) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'token_secret'").get();
  if (row) {
    SECRET = row.value;
  } else {
    SECRET = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO settings(key, value) VALUES('token_secret', ?)").run(SECRET);
  }
}

const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 12 * 3600 * 1000);

const b64u = buf => Buffer.from(buf).toString('base64url');

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function verifyPassword(password, salt, expected) {
  const got = Buffer.from(hashPassword(password, salt), 'hex');
  const want = Buffer.from(expected, 'hex');
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

/**
 * 密码强度检查。
 * 不追求复杂度教条（大小写符号混排已被 NIST 明确不推荐），
 * 只拦真正危险的：太短、纯数字、纯重复、常见弱口令。
 */
const WEAK_PASSWORDS = new Set([
  '123456', '1234567', '12345678', '123456789', 'password', 'passw0rd',
  'qwerty', 'abc123', '111111', '000000', 'admin123', 'iloveyou', '666666'
]);

function checkPassword(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < 6) return { ok: false, message: '密码至少 6 位' };
  if (s.length > 64) return { ok: false, message: '密码最长 64 位' };
  if (WEAK_PASSWORDS.has(s.toLowerCase())) return { ok: false, message: '这是常见弱口令，请换一个' };
  if (/^(\d)\1+$/.test(s) || /^(.)\1+$/.test(s)) return { ok: false, message: '密码不能是同一个字符重复' };
  if (/^\d+$/.test(s) && s.length < 8) return { ok: false, message: '纯数字密码至少 8 位' };
  return { ok: true };
}

/** 签发令牌。payload 里必须带 sid，否则无法吊销。 */
function signToken(payload, ttlMs = TOKEN_TTL_MS) {
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlMs };
  const data = b64u(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expect = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function hmacSign(secret, params) {
  const keys = Object.keys(params).sort();
  const base = keys.map(k => `${k}=${params[k]}`).join('&') + `&key=${secret}`;
  return crypto.createHmac('sha256', secret).update(base).digest('hex');
}

module.exports = {
  makeSalt, hashPassword, verifyPassword, checkPassword,
  signToken, verifyToken, hmacSign, TOKEN_TTL_MS
};
