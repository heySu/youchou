'use strict';
/**
 * 操作审计。
 * 只追加，不修改，不删除。任何「谁动了钱 / 谁改了权限」都能查到来源。
 *
 * 关键点：**越权尝试也要记**。有人拿审核员的令牌去调打款接口，
 * 即使被拦下，这条记录也必须留下——这是发现内部风险的主要信号。
 */
const { db, now } = require('../db');

/** 从 UA 粗略识别设备，只为后台列表可读，不参与安全判定 */
function deviceLabel(ua) {
  if (!ua) return '未知设备';
  const s = String(ua);
  const os =
    /Windows NT 10/.test(s) ? 'Windows' :
    /Windows/.test(s) ? 'Windows' :
    /iPhone|iOS/.test(s) ? 'iOS' :
    /Android/.test(s) ? 'Android' :
    /Mac OS X/.test(s) ? 'macOS' :
    /Linux/.test(s) ? 'Linux' : '其他';
  const browser =
    /Edg\//.test(s) ? 'Edge' :
    /Chrome\//.test(s) ? 'Chrome' :
    /Firefox\//.test(s) ? 'Firefox' :
    /Safari\//.test(s) ? 'Safari' :
    /curl\//i.test(s) ? 'curl' :
    /node|undici/i.test(s) ? 'Node 客户端' : '其他';
  return `${os} · ${browser}`;
}

function clientIp(ctx) {
  const fwd = ctx.req && ctx.req.headers && ctx.req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (ctx.ip || '').replace(/^::ffff:/, '') || null;
}

/**
 * 写一条审计。
 * @param {object} p
 * @param {object} [p.actor]   ctx.user（未登录时为空）
 * @param {string} p.action    动作标识，如 role.change
 * @param {string} [p.target]  被操作对象
 * @param {object} [p.detail]  变更前后等上下文
 * @param {string} [p.result]  ok | denied | failed
 */
function write({ actor, action, target, detail, ip, ua, result = 'ok' }) {
  try {
    db.prepare(`INSERT INTO audit_logs
        (actor_id, actor_name, actor_role, action, target, detail_json, ip, ua, result, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        actor ? actor.id : null,
        actor ? actor.name : null,
        actor ? actor.role : null,
        action,
        target || null,
        JSON.stringify(detail || {}),
        ip || null,
        ua ? String(ua).slice(0, 300) : null,
        result,
        now()
      );
  } catch (e) {
    // 审计失败不能拖垮业务请求，但必须打日志让人知道
    console.error('[audit] 写入失败', action, e.message);
  }
}

/** 从请求上下文写审计。登录动作此时 ctx.user 还没赋值，可显式传 actor 覆盖。 */
function fromCtx(ctx, { action, target, detail, result, actor }) {
  write({
    actor: actor || ctx.user,
    action,
    target,
    detail,
    result,
    ip: clientIp(ctx),
    ua: ctx.req && ctx.req.headers && ctx.req.headers['user-agent']
  });
}

/** 后台查询：按动作 / 操作人 / 结果筛选 */
function list({ action, actorId, result, limit = 50, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (action) { where.push('action LIKE ?'); args.push(action + '%'); }
  if (actorId) { where.push('actor_id = ?'); args.push(Number(actorId)); }
  if (result) { where.push('result = ?'); args.push(result); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${clause}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, Number(limit), Number(offset));

  return {
    total,
    logs: rows.map(r => ({
      id: r.id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      actorRole: r.actor_role,
      action: r.action,
      target: r.target,
      detail: safeParse(r.detail_json),
      ip: r.ip,
      device: deviceLabel(r.ua),
      result: r.result,
      createdAt: r.created_at
    }))
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return {}; }
}

module.exports = { write, fromCtx, list, deviceLabel, clientIp };
