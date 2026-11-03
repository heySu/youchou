'use strict';
const crypto = require('node:crypto');
const { db, tx, now } = require('../db');
const { HttpError } = require('../lib/http');
const { requireUser } = require('../lib/authz');
const wallet = require('../wallet');
const commission = require('../commission');

const MIN_WITHDRAW = 2000;    // ¥20
const MAX_WITHDRAW = 50000;   // ¥500
const DAILY_LIMIT = 200000;   // ¥2000

module.exports = function register(router) {
  router.get('/api/wallet', async ctx => {
    const u = requireUser(ctx);
    const w = wallet.getWallet(u.id);
    const pendingCount = db.prepare(
      "SELECT COUNT(*) AS c FROM commissions WHERE user_id = ? AND status IN ('pending','reviewing','approved')"
    ).get(u.id).c;
    return { ...w, pendingCount, minWithdraw: MIN_WITHDRAW };
  });

  router.get('/api/wallet/txns', async ctx => {
    const u = requireUser(ctx);
    const rows = db.prepare(
      'SELECT id, kind, amount_cents, memo, ref_type, created_at FROM wallet_txns WHERE user_id = ? ORDER BY id DESC LIMIT 60'
    ).all(u.id);
    return {
      txns: rows.map(t => ({
        id: t.id,
        kind: t.kind,
        amount: t.amount_cents,
        memo: t.memo,
        refType: t.ref_type,
        createdAt: t.created_at
      }))
    };
  });

  router.get('/api/commissions', async ctx => {
    const u = requireUser(ctx);
    const rows = commission.listByUser(u.id, 50);
    const sources = {};
    db.prepare('SELECT * FROM sources').all().forEach(s => { sources[s.key] = s; });
    return {
      commissions: rows.map(c => ({
        id: c.id,
        offerId: c.offer_id,
        title: c.title,
        reward: c.reward_cents,
        status: c.status,
        flags: JSON.parse(c.flags_json),
        createdAt: c.created_at,
        availableAt: c.available_at,
        source: sources[c.source_key]
          ? { key: c.source_key, name: sources[c.source_key].name, glyph: sources[c.source_key].glyph, color: sources[c.source_key].color }
          : null
      }))
    };
  });

  /** 我的提现记录：pending 表示已扣款待打款，paid 表示已到账 */
  router.get('/api/withdrawals', async ctx => {
    const u = requireUser(ctx);
    const rows = db.prepare(`SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 30`).all(u.id);
    return {
      withdrawals: rows.map(w => ({
        id: w.id,
        amount: w.amount_cents,
        channel: w.channel,
        status: w.status,          // pending | paid | failed
        createdAt: w.created_at,
        paidAt: w.paid_at
      }))
    };
  });

  router.post('/api/withdrawals', async ctx => {
    const u = requireUser(ctx);
    const { amount, channel } = ctx.body || {};
    const cents = Number(amount);

    if (!Number.isInteger(cents) || cents <= 0) throw new HttpError(400, 'bad_amount', '提现金额无效');
    if (cents < MIN_WITHDRAW) throw new HttpError(400, 'below_min', `单笔提现至少 ¥${MIN_WITHDRAW / 100}`);
    if (cents > MAX_WITHDRAW) throw new HttpError(400, 'above_max', `单笔提现上限 ¥${MAX_WITHDRAW / 100}`);
    if (!['wechat', 'alipay'].includes(channel)) throw new HttpError(400, 'bad_channel', '不支持的提现渠道');
    if (!u.real_name) throw new HttpError(403, 'need_realname', '请先完成实名认证');

    const w = wallet.getWallet(u.id);
    if (cents > w.available) throw new HttpError(400, 'insufficient', '可用余额不足');

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySum = db.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE user_id = ? AND status != 'failed' AND created_at >= ?"
    ).get(u.id, todayStart.toISOString()).s;
    if (todaySum + cents > DAILY_LIMIT) throw new HttpError(400, 'daily_limit', '超出今日提现额度');

    const id = 'wd_' + crypto.randomBytes(8).toString('hex');

    tx(() => {
      // 条件扣减，防止并发超提
      const upd = db.prepare('UPDATE wallets SET available_cents = available_cents - ? WHERE user_id = ? AND available_cents >= ?')
        .run(cents, u.id, cents);
      if (upd.changes === 0) throw new HttpError(400, 'insufficient', '可用余额不足');
      db.prepare(`INSERT INTO wallet_txns(user_id, kind, amount_cents, memo, ref_type, ref_id, created_at)
        VALUES(?,?,?,?,?,?,?)`)
        .run(u.id, 'withdraw_out', -cents, channel === 'wechat' ? '提现至微信零钱' : '提现至支付宝', 'withdrawal', id, now());
      db.prepare(`INSERT INTO withdrawals(id, user_id, amount_cents, channel, status, created_at, paid_at)
        VALUES(?,?,?,?, 'pending', ?, NULL)`).run(id, u.id, cents, channel, now());
    });

    // 提现单落 pending，等财务在后台确认打款。用户余额已扣，钱还在平台账上，不能标「已支付」。
    return { id, amount: cents, status: 'pending', wallet: wallet.getWallet(u.id) };
  });

  router.post('/api/me/realname', async ctx => {
    const u = requireUser(ctx);
    const { name, idNumber } = ctx.body || {};
    if (!name || String(name).trim().length < 2) throw new HttpError(400, 'bad_name', '请填写真实姓名');
    if (!idNumber || String(idNumber).trim().length < 6) throw new HttpError(400, 'bad_id', '请填写证件号');
    // 演示：不保存证件号，只标记已实名
    db.prepare('UPDATE users SET real_name = 1, name = ? WHERE id = ?').run(String(name).trim(), u.id);
    return { realName: true };
  });

  router.get('/api/me/stats', async ctx => {
    const u = requireUser(ctx);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const iso = today.toISOString();

    const todayRows = db.prepare(
      "SELECT COUNT(*) AS c, COALESCE(SUM(reward_cents),0) AS s FROM commissions WHERE user_id = ? AND created_at >= ? AND status NOT IN ('rejected','reversed')"
    ).get(u.id, iso);

    const agg = db.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status IN ('available','paid') THEN 1 ELSE 0 END),0) AS settled FROM commissions WHERE user_id = ? AND status NOT IN ('rejected','reversed')"
    ).get(u.id);

    const w = wallet.getWallet(u.id);
    return {
      todayCount: todayRows.c,
      todayEarned: todayRows.s,
      totalCount: agg.total,
      settledCount: agg.settled,
      passRate: agg.total ? Math.round(agg.settled / agg.total * 100) : 100,
      wallet: w
    };
  });
};
