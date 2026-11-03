'use strict';
const crypto = require('node:crypto');
const { db, tx, now } = require('../db');
const { HttpError } = require('../lib/http');
const { requireUser } = require('../lib/authz');
const risk = require('../risk');
const commission = require('../commission');
const wallet = require('../wallet');
const { scheduleSimulatedPostback } = require('../sources');

/** 面向用户的题目视图：不暴露注意力校验答案 */
const publicQuestions = questions => questions.map(q => {
  const { attentionAnswer, attn, ...rest } = q;
  return rest;
});

const publicOffer = (o, src) => ({
  id: o.id,
  title: o.title,
  description: o.description,
  minutes: o.minutes,
  questionCount: JSON.parse(o.questions_json).length,
  reward: o.reward_cents,
  totalQuota: o.total_quota,
  leftQuota: o.left_quota,
  tags: JSON.parse(o.tags_json),
  category: o.category,
  // 站内答题（inline）还是跳转题源完成（external）
  origin: o.origin || 'seed',
  delivery: o.delivery || 'inline',
  externalUrl: o.external_url || null,
  source: { key: src.key, name: src.name, glyph: src.glyph, color: src.color, mode: src.mode }
});

function validateAnswers(questions, answers) {
  if (!Array.isArray(answers)) return '答案格式错误';
  if (answers.length !== questions.length) return `题目数量不匹配（期望 ${questions.length}，收到 ${answers.length}）`;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i];
    if (q.type === 'single' || q.type === 'scale') {
      if (!Number.isInteger(a) || a < 0 || a >= q.opts.length) return `第 ${i + 1} 题未作答或选项越界`;
    } else if (q.type === 'multi') {
      if (!Array.isArray(a) || a.length === 0) return `第 ${i + 1} 题为多选题，至少选择 1 项`;
      if (q.max && a.length > q.max) return `第 ${i + 1} 题最多选择 ${q.max} 项`;
      if (a.some(x => !Number.isInteger(x) || x < 0 || x >= q.opts.length)) return `第 ${i + 1} 题选项越界`;
    } else if (q.type === 'text') {
      if (typeof a !== 'string' || a.trim().length < (q.min || 1)) return `第 ${i + 1} 题回答过短`;
      if (a.length > 200) return `第 ${i + 1} 题回答过长`;
    }
  }
  return null;
}

module.exports = function register(router) {
  // ---- 问卷池 ----
  router.get('/api/offers', async ctx => {
    const u = requireUser(ctx);
    const rows = db.prepare(`
      SELECT o.*, s.name AS s_name, s.glyph AS s_glyph, s.color AS s_color, s.mode AS s_mode, s.status AS s_status
      FROM offers o JOIN sources s ON s.key = o.source_key
      WHERE o.status = 'open' AND s.status != 'paused'
      ORDER BY o.reward_cents DESC`).all();

    const done = new Set(
      db.prepare(`SELECT DISTINCT offer_id FROM commissions
        WHERE user_id = ? AND status NOT IN ('rejected','reversed')`).all(u.id).map(r => r.offer_id)
    );

    return {
      offers: rows.map(r => ({
        ...publicOffer(r, { key: r.source_key, name: r.s_name, glyph: r.s_glyph, color: r.s_color, mode: r.s_mode }),
        completed: done.has(r.id),
        sourceStatus: r.s_status
      })),
      stats: {
        total: rows.length,
        available: rows.filter(r => !done.has(r.id)).length,
        maxReward: rows.length ? Math.max(...rows.map(r => r.reward_cents)) : 0
      }
    };
  });

  router.get('/api/offers/:id', async ctx => {
    requireUser(ctx);
    const o = db.prepare('SELECT * FROM offers WHERE id = ?').get(ctx.params.id);
    if (!o) throw new HttpError(404, 'offer_not_found', '问卷不存在');
    const src = db.prepare('SELECT * FROM sources WHERE key = ?').get(o.source_key);
    return {
      ...publicOffer(o, src),
      questions: publicQuestions(JSON.parse(o.questions_json))
    };
  });

  // ---- 开始答题：锁配额 + 建会话 ----
  router.post('/api/sessions', async ctx => {
    const u = requireUser(ctx);
    const { offerId, deviceId } = ctx.body || {};
    if (!offerId) throw new HttpError(400, 'missing_offer', '缺少 offerId');

    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
    if (!offer) throw new HttpError(404, 'offer_not_found', '问卷不存在');
    if (offer.status !== 'open') throw new HttpError(409, 'offer_closed', '该问卷已下线');

    const src = db.prepare('SELECT * FROM sources WHERE key = ?').get(offer.source_key);
    if (!src || src.status === 'paused') throw new HttpError(409, 'source_paused', '该题源暂停接单');

    const already = db.prepare(`SELECT id FROM commissions
      WHERE user_id = ? AND offer_id = ? AND status NOT IN ('rejected','reversed')`).get(u.id, offerId);
    if (already) throw new HttpError(409, 'already_completed', '你已完成过该问卷');

    const sessionId = 'ss_' + crypto.randomBytes(8).toString('hex');

    tx(() => {
      const upd = db.prepare("UPDATE offers SET left_quota = left_quota - 1 WHERE id = ? AND left_quota > 0 AND status = 'open'")
        .run(offerId);
      if (upd.changes === 0) throw new HttpError(409, 'quota_exhausted', '该问卷配额已满');
      db.prepare(`INSERT INTO sessions(id, user_id, offer_id, device_id, ip, started_at, status)
        VALUES (?,?,?,?,?,?, 'open')`)
        .run(sessionId, u.id, offerId, deviceId || u.device_id || null, ctx.ip || null, now());
    });

    return {
      sessionId,
      offer: {
        id: offer.id,
        title: offer.title,
        minutes: offer.minutes,
        reward: offer.reward_cents,
        source: { key: src.key, name: src.name, glyph: src.glyph, color: src.color },
        questions: publicQuestions(JSON.parse(offer.questions_json))
      },
      startedAt: now()
    };
  });

  // ---- 提交答卷 ----
  router.post('/api/responses', async ctx => {
    const u = requireUser(ctx);
    const { sessionId, answers } = ctx.body || {};
    if (!sessionId) throw new HttpError(400, 'missing_session', '缺少 sessionId');

    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!s) throw new HttpError(404, 'session_not_found', '答题会话不存在');
    if (s.user_id !== u.id) throw new HttpError(403, 'forbidden', '无权提交他人的答卷');
    if (s.status !== 'open') throw new HttpError(409, 'session_closed', '该会话已提交');

    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(s.offer_id);
    const questions = JSON.parse(offer.questions_json);

    const err = validateAnswers(questions, answers);
    if (err) throw new HttpError(400, 'invalid_answers', err);

    // 服务端计时，客户端无法伪造
    const durationMs = Math.max(0, Date.now() - new Date(s.started_at).getTime());

    const dup = db.prepare(`SELECT id FROM commissions
      WHERE user_id = ? AND offer_id = ? AND session_id != ? AND status NOT IN ('rejected','reversed')`)
      .get(u.id, offer.id, sessionId);

    const flags = risk.evaluate({
      userId: u.id,
      sessionId,
      questions,
      answers,
      durationMs,
      deviceId: s.device_id,
      duplicate: !!dup
    });

    const transactionId = `${offer.source_key}_${crypto.randomBytes(8).toString('hex')}`;

    const result = tx(() => {
      const c = commission.create({
        userId: u.id, offer, sessionId, transactionId, flags, durationMs
      });
      db.prepare('UPDATE sessions SET status = ?, submitted_at = ?, duration_ms = ? WHERE id = ?')
        .run('submitted', now(), durationMs, sessionId);
      db.prepare('INSERT INTO responses(session_id, answers_json, flags_json, created_at) VALUES(?,?,?,?)')
        .run(sessionId, JSON.stringify(answers), JSON.stringify(flags), now());
      return c;
    });

    // 真实题源无论我方风控结论如何都会回调；这里同样始终发起，
    // 若该单被风控扣在复核中，回调会被记为 awaiting_review。
    scheduleSimulatedPostback({
      sourceKey: offer.source_key,
      transactionId,
      offerId: offer.id,
      userRef: u.id,
      payoutCents: offer.pay_cents
    });

    return {
      commission: {
        id: result.id,
        status: result.status,
        reward: result.reward_cents,
        flags: JSON.parse(result.flags_json),
        createdAt: result.created_at
      },
      durationMs,
      wallet: wallet.getWallet(u.id)
    };
  });
};
