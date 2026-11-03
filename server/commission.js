'use strict';
/**
 * 佣金状态机与结算。
 *
 *   pending   —— 答卷已提交，佣金冻结（等待题源 Postback 确认）
 *   reviewing —— 风控命中，等待人工复核
 *   approved  —— 题源已确认 + 风控通过，等待冻结期结束
 *   available —— 已解冻，计入可用余额，可提现
 *   paid      —— 已提现
 *   rejected  —— 驳回，佣金回滚、配额返还
 *   reversed  —— 题源事后冲正
 */
const crypto = require('node:crypto');
const { db, now, tx } = require('./db');
const wallet = require('./wallet');

const FREEZE_MS = Number(process.env.FREEZE_MS || 60 * 1000);
const newId = prefix => prefix + crypto.randomBytes(8).toString('hex');

const get = id => db.prepare('SELECT * FROM commissions WHERE id = ?').get(id);

/** 提交答卷后创建佣金单；命中风控则直接进入复核 */
function create({ userId, offer, sessionId, transactionId, flags, durationMs }) {
  return tx(() => {
    const status = flags.length ? 'reviewing' : 'pending';
    const id = newId('cm_');
    db.prepare(`INSERT INTO commissions
      (id, user_id, offer_id, session_id, transaction_id, reward_cents, pay_cents, status, flags_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, offer.id, sessionId, transactionId, offer.reward_cents,
           offer.pay_cents, status, JSON.stringify(flags), now());

    wallet.creditPending(userId, offer.reward_cents, 'commission', id,
      flags.length ? '问卷佣金（待复核）' : '问卷佣金（待结算）');

    return get(id);
  });
}

/** 题源 Postback 确认 */
function markApproved(commissionId, { payoutCents, sourceKey } = {}) {
  return tx(() => {
    const c = get(commissionId);
    if (!c) return { ok: false, reason: 'not_found' };
    if (c.status !== 'pending') return { ok: false, reason: `illegal_state:${c.status}` };
    db.prepare('UPDATE commissions SET status = ?, approved_at = ? WHERE id = ?')
      .run('approved', now(), commissionId);
    return { ok: true, commission: get(commissionId) };
  });
}

/** 人工复核 */
function review(commissionId, { action, reviewer = 'admin', note = '' }) {
  return tx(() => {
    const c = get(commissionId);
    if (!c) return { ok: false, reason: 'not_found' };
    if (c.status !== 'reviewing') return { ok: false, reason: `illegal_state:${c.status}` };

    if (action === 'approve') {
      db.prepare('UPDATE commissions SET status = ?, approved_at = ?, reviewer = ?, review_note = ? WHERE id = ?')
        .run('approved', now(), reviewer, note, commissionId);
    } else if (action === 'reject') {
      db.prepare('UPDATE commissions SET status = ?, reviewer = ?, review_note = ? WHERE id = ?')
        .run('rejected', reviewer, note, commissionId);
      wallet.rejectPending(c.user_id, c.reward_cents, 'commission', commissionId, '复核未通过，佣金回滚');
      // 配额返还
      db.prepare('UPDATE offers SET left_quota = MIN(total_quota, left_quota + 1) WHERE id = ?').run(c.offer_id);
    } else {
      return { ok: false, reason: 'bad_action' };
    }
    return { ok: true, commission: get(commissionId) };
  });
}

/** 冻结期到期解冻（定时任务 / 后台手动触发） */
function runSettlement(at = new Date()) {
  const deadline = new Date(at.getTime() - FREEZE_MS).toISOString();
  const rows = db.prepare("SELECT * FROM commissions WHERE status = 'approved' AND approved_at <= ?").all(deadline);
  let released = 0;
  for (const c of rows) {
    tx(() => {
      wallet.releasePending(c.user_id, c.reward_cents, 'commission', c.id, '冻结期结束，佣金可提现');
      db.prepare("UPDATE commissions SET status = 'available', available_at = ? WHERE id = ?").run(now(), c.id);
    });
    released++;
  }
  return { released, checked: rows.length, freezeMs: FREEZE_MS };
}

/** 题源事后冲正 */
function reverse(commissionId, reason) {
  return tx(() => {
    const c = get(commissionId);
    if (!c) return { ok: false, reason: 'not_found' };
    if (c.status === 'reversed') return { ok: true, idempotent: true };
    if (c.status === 'available') {
      wallet.reverseAvailable(c.user_id, c.reward_cents, 'commission', c.id, reason || '题源冲正');
    } else if (c.status === 'pending' || c.status === 'approved' || c.status === 'reviewing') {
      wallet.rejectPending(c.user_id, c.reward_cents, 'commission', c.id, reason || '题源冲正');
    }
    db.prepare("UPDATE commissions SET status = 'reversed', review_note = ? WHERE id = ?").run(reason || '题源冲正', commissionId);
    return { ok: true, commission: get(commissionId) };
  });
}

function listByUser(userId, limit = 50) {
  return db.prepare(`
    SELECT c.*, o.title, o.source_key
    FROM commissions c JOIN offers o ON o.id = c.offer_id
    WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(userId, limit);
}

function listForReview(limit = 100) {
  return db.prepare(`
    SELECT c.*, o.title, o.source_key, u.name AS user_name, u.phone, s.duration_ms
    FROM commissions c
    JOIN offers o ON o.id = c.offer_id
    JOIN users u ON u.id = c.user_id
    LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.status = 'reviewing' ORDER BY c.created_at ASC LIMIT ?`).all(limit);
}

module.exports = { create, markApproved, review, runSettlement, reverse, listByUser, listForReview, get, FREEZE_MS };
