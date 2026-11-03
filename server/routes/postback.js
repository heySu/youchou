'use strict';
/**
 * S2S Postback 接收端。
 * 这是整套系统里唯一有权把佣金从 pending 推进到 approved 的入口。
 */
const { db, now } = require('../db');
const { HttpError } = require('../lib/http');
const { hmacSign } = require('../auth');
const commission = require('../commission');

const TIME_WINDOW_SEC = 300;

function log(payload, sourceKey, transactionId, signValid, result) {
  db.prepare(`INSERT INTO postback_logs(source_key, transaction_id, payload_json, sign_valid, result, created_at)
    VALUES(?,?,?,?,?,?)`)
    .run(sourceKey, transactionId || null, JSON.stringify(payload), signValid ? 1 : 0, result, now());
}

module.exports = function register(router) {
  router.post('/api/postback/:key', async ctx => {
    const sourceKey = ctx.params.key;
    const body = ctx.body || {};
    const src = db.prepare('SELECT * FROM sources WHERE key = ?').get(sourceKey);

    if (!src) {
      throw new HttpError(404, 'unknown_source', '未知题源');
    }

    const { signature, ...params } = body;
    const transactionId = params.transaction_id;

    // 1. 验签
    const expect = hmacSign(src.secret, params);
    const signValid = !!signature && signature === expect;
    if (!signValid) {
      log(body, sourceKey, transactionId, false, 'invalid_signature');
      throw new HttpError(401, 'invalid_signature', '签名校验失败');
    }

    // 2. 时间窗
    const ts = Number(params.timestamp);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > TIME_WINDOW_SEC) {
      log(body, sourceKey, transactionId, true, 'expired');
      throw new HttpError(400, 'expired', '回调时间戳超出允许窗口');
    }

    if (!transactionId) {
      log(body, sourceKey, null, true, 'missing_txn');
      throw new HttpError(400, 'missing_txn', '缺少 transaction_id');
    }

    const c = db.prepare('SELECT * FROM commissions WHERE transaction_id = ?').get(transactionId);

    // 3. 幂等：未知单号 / 重复回调都返回 200，由对方停止重试
    if (!c) {
      log(body, sourceKey, transactionId, true, 'unknown_txn');
      return { ok: true, result: 'unknown_txn' };
    }

    // 题源已确认，但风控把单子扣在人工复核：保持 reviewing，等审核结论
    if (c.status === 'reviewing' && params.status === 'complete') {
      log(body, sourceKey, transactionId, true, 'awaiting_review');
      return { ok: true, result: 'awaiting_review', commissionId: c.id };
    }

    if (params.status === 'reversal') {
      const r = commission.reverse(c.id, '题源冲正');
      log(body, sourceKey, transactionId, true, 'reversed');
      return { ok: true, result: 'reversed', commissionId: c.id, status: r.commission ? r.commission.status : null };
    }

    if (params.status !== 'complete') {
      // screenout：用户不符合条件，按驳回处理，佣金回滚
      if (c.status === 'reviewing') {
        commission.review(c.id, { action: 'reject', reviewer: 'postback', note: '题源返回 screenout' });
      }
      log(body, sourceKey, transactionId, true, 'screenout');
      return { ok: true, result: 'screenout' };
    }

    const r = commission.markApproved(c.id, { payoutCents: Math.round(Number(params.payout || 0) * 100), sourceKey });
    if (!r.ok) {
      // 已 approved / available / rejected → 重复回调，幂等返回
      log(body, sourceKey, transactionId, true, 'duplicate:' + r.reason);
      return { ok: true, result: 'duplicate', reason: r.reason };
    }

    log(body, sourceKey, transactionId, true, 'approved');
    return { ok: true, result: 'approved', commissionId: c.id, status: 'approved' };
  });
};
