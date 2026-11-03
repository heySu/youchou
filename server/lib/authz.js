'use strict';
const { HttpError } = require('./http');
const { db } = require('../db');
const { hasPermission, permissionsOf, canUseBackend, ROLES } = require('./rbac');
const audit = require('./audit');

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'unauthorized', '请先登录');
  if (ctx.user.status && ctx.user.status !== 'active') {
    throw new HttpError(403, 'account_disabled', '账号已被禁用，请联系管理员');
  }
  return ctx.user;
}

/**
 * 要求某个权限点。
 * 越权尝试一定落审计——这是发现内部风险最有效的信号：
 * 一个审核员反复去点打款接口，比任何告警都说明问题。
 */
function requirePermission(ctx, perm) {
  const u = requireUser(ctx);

  if (!canUseBackend(u.role)) {
    audit.fromCtx(ctx, {
      action: 'auth.denied',
      target: perm,
      result: 'denied',
      detail: { reason: 'not_backend_user', role: u.role }
    });
    throw new HttpError(403, 'forbidden', '没有后台访问权限');
  }

  if (!hasPermission(u, perm)) {
    audit.fromCtx(ctx, {
      action: 'auth.denied',
      target: perm,
      result: 'denied',
      detail: { reason: 'missing_permission', role: u.role, need: perm }
    });
    throw new HttpError(403, 'forbidden', `缺少权限：${perm}`);
  }

  return u;
}

/** 兼容旧写法：等价于「任意一个后台权限」 */
function requireAdmin(ctx) {
  return requirePermission(ctx, 'dashboard:view');
}

/** 不能操作同级或更高角色——防止运营把自己提成超管 */
function assertCanManage(ctx, targetUser) {
  const actor = requirePermission(ctx, 'member:manage');
  if (targetUser.id === actor.id) {
    throw new HttpError(400, 'self_operation', '不能修改自己的角色或状态');
  }
  const { levelOf } = require('./rbac');
  if (levelOf(targetUser.role) >= levelOf(actor.role)) {
    throw new HttpError(403, 'forbidden', '不能操作同级或更高权限的账号');
  }
  return actor;
}

function getUserById(id) {
  return db.prepare(`SELECT id, phone, name, role, status, credit_score, invite_code,
      invited_by, device_id, real_name, created_at, last_login_at, locked_until, remark
    FROM users WHERE id = ?`).get(id);
}

/** 组装前端需要的身份信息（含展开后的权限清单） */
function identity(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    roleLabel: ROLES[user.role] ? ROLES[user.role].label : user.role,
    status: user.status || 'active',
    creditScore: user.credit_score,
    inviteCode: user.invite_code,
    realName: !!user.real_name,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at || null,
    permissions: permissionsOf(user.role)
  };
}

module.exports = { requireUser, requirePermission, requireAdmin, assertCanManage, getUserById, identity };
