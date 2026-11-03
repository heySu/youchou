'use strict';
const crypto = require('node:crypto');
const { db, tx, now } = require('../db');
const { HttpError } = require('../lib/http');
const {
  makeSalt, hashPassword, verifyPassword, signToken,
  checkPassword, TOKEN_TTL_MS
} = require('../auth');
const session = require('../session');
const audit = require('../lib/audit');
const { requireUser, getUserById, identity } = require('../lib/authz');
const { permissionsOf, canUseBackend } = require('../lib/rbac');
const wallet = require('../wallet');

const PUBLIC_FIELDS = `id, phone, name, role, status, credit_score, invite_code, invited_by,
  device_id, real_name, created_at, last_login_at, locked_until`;

/** 登录失败锁定策略 */
const LOCK_THRESHOLD = Number(process.env.LOCK_THRESHOLD || 5);
const LOCK_MS = Number(process.env.LOCK_MS || 15 * 60 * 1000);

function issue(user, ctx) {
  const sess = session.create(user.id, {
    ip: audit.clientIp(ctx),
    ua: ctx.req && ctx.req.headers['user-agent']
  });

  return {
    token: sess.token,
    sessionExpiresAt: sess.expiresAt,
    user: identity(user),
    wallet: wallet.getWallet(user.id)
  };
}

function recordLogin(account, ip, ok, reason) {
  db.prepare('INSERT INTO login_attempts(account, ip, ok, reason, created_at) VALUES (?,?,?,?,?)')
    .run(String(account || '').slice(0, 80), ip || null, ok ? 1 : 0, reason || null, now());
}

/** 最近 5 分钟内同 IP 的失败次数，用于提示与排查（锁定按账号走） */
function recentFailsByIp(ip) {
  if (!ip) return 0;
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  return db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND ok = 0 AND created_at >= ?')
    .get(ip, since).c;
}

module.exports = function register(router) {
  router.post('/api/auth/register', async ctx => {
    const { phone, password, name, deviceId, invitedBy } = ctx.body || {};
    if (!phone || String(phone).trim().length < 3) throw new HttpError(400, 'bad_phone', '手机号 / 账号至少 3 位');

    const pw = checkPassword(password);
    if (!pw.ok) throw new HttpError(400, 'weak_password', pw.message);

    const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(String(phone).trim());
    if (exists) throw new HttpError(409, 'phone_taken', '该账号已注册');

    const salt = makeSalt();
    const code = 'YC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    let inviterId = null;
    if (invitedBy) {
      const inv = db.prepare('SELECT id FROM users WHERE invite_code = ?').get(invitedBy);
      if (inv) inviterId = inv.id;
    }

    const id = tx(() => {
      const r = db.prepare(`INSERT INTO users
        (phone, name, password_hash, salt, role, status, credit_score, invite_code,
         invited_by, device_id, real_name, created_at, password_updated_at)
        VALUES (?,?,?,?, 'user', 'active', 100, ?, ?, ?, 0, ?, ?)`)
        .run(String(phone).trim(), (name && String(name).trim()) || '用户' + String(phone).slice(-4),
          hashPassword(String(password), salt), salt, code, inviterId, deviceId || null, now(), now());
      const uid = Number(r.lastInsertRowid);
      wallet.ensureWallet(uid);
      return uid;
    });

    const user = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(id);
    audit.fromCtx(ctx, { action: 'auth.register', target: `user:${id}`, detail: { phone: user.phone } });
    ctx.status = 201;
    return issue(user, ctx);
  });

  router.post('/api/auth/login', async ctx => {
    const { phone, password, admin } = ctx.body || {};
    if (!phone || !password) throw new HttpError(400, 'missing_fields', '请填写账号与密码');

    const account = String(phone).trim();
    const ip = audit.clientIp(ctx);
    const row = db.prepare('SELECT * FROM users WHERE phone = ?').get(account);

    // 账号被锁定：给出明确剩余时间，不模糊处理——用户有权知道自己在等什么
    if (row && row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      const retryAfter = Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 1000);
      recordLogin(account, ip, 0, 'locked');
      throw new HttpError(429, 'account_locked',
        `登录失败次数过多，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`, { retryAfter });
    }

    if (!row || !verifyPassword(String(password), row.salt, row.password_hash)) {
      // 统一错误文案，不区分「账号不存在」和「密码错误」，避免账号枚举
      if (row) {
        const failed = (row.failed_count || 0) + 1;
        const lockUntil = failed >= LOCK_THRESHOLD
          ? new Date(Date.now() + LOCK_MS).toISOString()
          : null;
        db.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?')
          .run(lockUntil ? 0 : failed, lockUntil, row.id);
        if (lockUntil) {
          audit.write({
            actor: { id: row.id, name: row.name, role: row.role },
            action: 'auth.locked',
            target: `user:${row.id}`,
            detail: { failed, lockMinutes: LOCK_MS / 60000 },
            ip, ua: ctx.req.headers['user-agent'], result: 'failed'
          });
        }
      }
      recordLogin(account, ip, 0, 'bad_credentials');
      throw new HttpError(401, 'bad_credentials', '账号或密码错误');
    }

    if (row.status && row.status !== 'active') {
      recordLogin(account, ip, 0, 'disabled');
      throw new HttpError(403, 'account_disabled', '账号已被禁用，请联系管理员');
    }

    // 从后台入口登录的必须是后台角色，避免普通用户误入
    if (admin && !canUseBackend(row.role)) {
      recordLogin(account, ip, 0, 'not_backend_user');
      throw new HttpError(403, 'forbidden', '该账号没有后台访问权限');
    }

    db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(now(), row.id);
    recordLogin(account, ip, 1, null);
    audit.fromCtx(ctx, {
      actor: { id: row.id, name: row.name, role: row.role },
      action: 'auth.login',
      target: `user:${row.id}`,
      detail: { role: row.role }
    });

    return issue(row, ctx);
  });

  /** 续期：会话还活着就换一张新令牌，不改变登录设备 */
  router.post('/api/auth/refresh', async ctx => {
    const u = requireUser(ctx);
    return {
      token: signToken({ uid: u.id, sid: ctx.sid }, TOKEN_TTL_MS),
      expiresIn: TOKEN_TTL_MS,
      user: identity(getUserById(u.id))
    };
  });

  router.post('/api/auth/logout', async ctx => {
    const u = requireUser(ctx);
    session.revoke(ctx.sid, 'logout');
    audit.fromCtx(ctx, { action: 'auth.logout', target: `session:${ctx.sid}` });
    return { ok: true };
  });

  router.get('/api/me', async ctx => {
    const u = requireUser(ctx);
    const full = getUserById(u.id);
    if (!full) throw new HttpError(404, 'not_found', '用户不存在');
    return { user: identity(full), wallet: wallet.getWallet(full.id) };
  });

  /** 改密码：旧密码必须对，改完把其他设备全部踢下线 */
  router.post('/api/auth/password', async ctx => {
    const u = requireUser(ctx);
    const { oldPassword, newPassword } = ctx.body || {};
    if (!oldPassword || !newPassword) throw new HttpError(400, 'missing_fields', '请填写原密码与新密码');

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    if (!verifyPassword(String(oldPassword), row.salt, row.password_hash)) {
      audit.fromCtx(ctx, { action: 'auth.password_change', target: `user:${u.id}`, result: 'failed', detail: { reason: 'bad_old_password' } });
      throw new HttpError(400, 'bad_old_password', '原密码不正确');
    }
    if (String(newPassword) === String(oldPassword)) {
      throw new HttpError(400, 'same_password', '新密码不能与原密码相同');
    }
    const pw = checkPassword(newPassword);
    if (!pw.ok) throw new HttpError(400, 'weak_password', pw.message);

    const salt = makeSalt();
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, password_updated_at = ? WHERE id = ?')
      .run(hashPassword(String(newPassword), salt), salt, now(), u.id);

    // 改密码的核心意义就在这一步：旧令牌全部作废
    const killed = session.revokeAll(u.id, { exceptSid: ctx.sid, reason: 'password_changed' });
    audit.fromCtx(ctx, {
      action: 'auth.password_change',
      target: `user:${u.id}`,
      detail: { revokedSessions: killed }
    });

    return { ok: true, revokedSessions: killed };
  });

  /** 我的登录设备 */
  router.get('/api/auth/sessions', async ctx => {
    const u = requireUser(ctx);
    return {
      sessions: session.listByUser(u.id, ctx.sid),
      tokenTtlMinutes: TOKEN_TTL_MS / 60000
    };
  });

  /** 踢掉某个设备 */
  router.del('/api/auth/sessions/:id', async ctx => {
    const u = requireUser(ctx);
    const target = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(ctx.params.id);
    if (!target || target.user_id !== u.id) throw new HttpError(404, 'not_found', '会话不存在');
    if (target.id === ctx.sid) throw new HttpError(400, 'self_session', '不能踢掉当前设备，请直接退出登录');
    session.revoke(target.id, 'kicked');
    audit.fromCtx(ctx, { action: 'auth.session_revoke', target: `session:${target.id}`, detail: { device: target.device } });
    return { ok: true, sessions: session.listByUser(u.id, ctx.sid) };
  });

  /** 退出所有设备 */
  router.post('/api/auth/logout-all', async ctx => {
    const u = requireUser(ctx);
    const killed = session.revokeAll(u.id, { reason: 'logout_all' });
    audit.fromCtx(ctx, { action: 'auth.logout_all', target: `user:${u.id}`, detail: { revokedSessions: killed } });
    return { ok: true, revokedSessions: killed };
  });

  /** 我的权限（前端渲染按钮用，最终以后端校验为准） */
  router.get('/api/auth/permissions', async ctx => {
    const u = requireUser(ctx);
    return {
      role: u.role,
      permissions: permissionsOf(u.role),
      backend: canUseBackend(u.role)
    };
  });
};
