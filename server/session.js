'use strict';
/**
 * 登录会话。
 *
 * 无状态令牌的致命伤是「发出去就收不回」：改密码、禁用账号、怀疑泄露，
 * 全都没法让已签发的令牌立刻失效，只能等它自然过期。
 * 所以这里加一层服务端会话表——令牌只是「会话 id 的载体」，
 * 每次请求都回来查一次会话是否还活着。代价是一次主键查询，换来可吊销。
 */
const crypto = require('node:crypto');
const { db, now } = require('./db');
const { signToken, TOKEN_TTL_MS } = require('./auth');
const { deviceLabel } = require('./lib/audit');

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 3600 * 1000);

const iso = ms => new Date(ms).toISOString();

function create(userId, { ip, ua } = {}) {
  const sid = 'ss_' + crypto.randomBytes(16).toString('hex');
  const t = Date.now();
  db.prepare(`INSERT INTO auth_sessions
      (id, user_id, ip, ua, device, created_at, last_seen_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(sid, userId, ip || null, ua ? String(ua).slice(0, 300) : null,
      deviceLabel(ua), now(), now(), iso(t + SESSION_TTL_MS));

  return {
    sid,
    expiresAt: iso(t + SESSION_TTL_MS),
    token: signToken({ uid: userId, sid }, TOKEN_TTL_MS)
  };
}

/** 查会话是否有效：未吊销、未过期 */
function verify(sid, userId) {
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(sid);
  if (!s) return null;
  if (s.revoked_at) return null;
  if (s.user_id !== userId) return null;
  if (new Date(s.expires_at).getTime() <= Date.now()) return null;
  return s;
}

/** 记录活跃时间，用于「最近使用」列。节流到 60 秒，避免每请求一次写库。 */
function touch(sid, lastSeenAt) {
  if (!sid) return;
  if (lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 60_000) return;
  db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now(), sid);
}

function revoke(sid, reason = 'logout') {
  const r = db.prepare('UPDATE auth_sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now(), reason, sid);
  return r.changes > 0;
}

/** 吊销某用户全部会话（改密码、被禁用、主动全端下线时用） */
function revokeAll(userId, { exceptSid, reason = 'revoked' } = {}) {
  const r = exceptSid
    ? db.prepare('UPDATE auth_sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
      .run(now(), reason, userId, exceptSid)
    : db.prepare('UPDATE auth_sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now(), reason, userId);
  return r.changes;
}

/** 我的登录设备：只列还有效的 */
function listByUser(userId, currentSid) {
  return db.prepare(`SELECT * FROM auth_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_seen_at DESC`)
    .all(userId, now())
    .map(s => ({
      id: s.id,
      device: s.device || deviceLabel(s.ua),
      ip: s.ip,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      current: s.id === currentSid
    }));
}

/** 清理过期且已失效的会话记录，避免表无限增长 */
function cleanup() {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const r = db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(cutoff);
  return r.changes;
}

module.exports = { create, verify, touch, revoke, revokeAll, listByUser, cleanup, SESSION_TTL_MS, TOKEN_TTL_MS };
