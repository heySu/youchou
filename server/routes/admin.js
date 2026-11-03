'use strict';
const { db, tx, now } = require('../db');
const { HttpError } = require('../lib/http');
const { requirePermission, getUserById, identity, assertCanManage } = require('../lib/authz');
const { ROLES, PERMISSIONS, isValidRole, permissionsOf, levelOf } = require('../lib/rbac');
const audit = require('../lib/audit');
const session = require('../session');
const commission = require('../commission');
const risk = require('../risk');
const wallet = require('../wallet');
const crawler = require('../crawler');

const dayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

module.exports = function register(router) {
  router.get('/api/admin/overview', async ctx => {
    requirePermission(ctx, "dashboard:view");
    const t0 = dayStart();

    const today = db.prepare(`SELECT
        COUNT(*) AS completed,
        COALESCE(SUM(pay_cents),0) AS pay,
        COALESCE(SUM(reward_cents),0) AS reward
      FROM commissions WHERE created_at >= ? AND status NOT IN ('rejected','reversed')`).get(t0);

    const review = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(reward_cents),0) AS s FROM commissions WHERE status = 'reviewing'").get();
    const pending = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(reward_cents),0) AS s FROM commissions WHERE status IN ('pending','approved')").get();
    const paidToday = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE status = 'paid' AND paid_at >= ?").get(t0);
    const riskToday = db.prepare('SELECT COUNT(*) AS c FROM risk_events WHERE created_at >= ?').get(t0);

    // 注意：created_at 存的是 UTC，按本地时区聚合才能和「今日」口径一致
    const rawSeries = db.prepare(`SELECT date(created_at, 'localtime') AS d,
        COALESCE(SUM(pay_cents),0) AS pay, COUNT(*) AS c
      FROM commissions WHERE status NOT IN ('rejected','reversed')
      GROUP BY date(created_at, 'localtime')`).all();
    const byDay = new Map(rawSeries.map(s => [s.d, s]));
    const pad = n => String(n).padStart(2, '0');
    const series = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const hit = byDay.get(key);
      series.push({ date: key, pay: hit ? hit.pay : 0, count: hit ? hit.c : 0 });
    }

    const margin = today.pay > 0 ? Math.round((today.pay - today.reward) / today.pay * 1000) / 10 : 0;

    // 概览自带题源表现与最近回调，
    // 这样只有 dashboard:view 的角色（如财务）看首页时不会去碰 source:view / postback:view
    const sourcePerf = db.prepare(`
      SELECT s.key, s.name, s.glyph, s.color, s.status,
        (SELECT COUNT(*) FROM offers o WHERE o.source_key = s.key) AS offers,
        (SELECT COALESCE(SUM(c.reward_cents),0) FROM commissions c
           JOIN offers o2 ON o2.id = c.offer_id
           WHERE o2.source_key = s.key AND c.created_at >= ?
             AND c.status NOT IN ('rejected','reversed')) AS today_reward
      FROM sources s
      ORDER BY today_reward DESC, s.key`).all(t0);

    const recentPostbacks = db.prepare(`SELECT * FROM postback_logs ORDER BY id DESC LIMIT 8`).all();

    return {
      today: {
        completed: today.completed,
        pay: today.pay,
        reward: today.reward,
        margin
      },
      review: { count: review.c, amount: review.s },
      pending: { count: pending.c, amount: pending.s },
      paidToday: paidToday.s,
      riskToday: riskToday.c,
      series,
      sourcePerf,
      recentPostbacks: recentPostbacks.map(p => ({
        id: p.id,
        sourceKey: p.source_key,
        transactionId: p.transaction_id,
        signValid: p.sign_valid === 1,
        result: p.result,
        createdAt: p.created_at
      })),
      userCount: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'user'").get().c
    };
  });

  router.get('/api/admin/sources', async ctx => {
    requirePermission(ctx, "source:view");
    const rows = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM offers o WHERE o.source_key = s.key) AS offer_count,
        (SELECT COALESCE(SUM(c.reward_cents),0) FROM commissions c
           JOIN offers o2 ON o2.id = c.offer_id
           WHERE o2.source_key = s.key AND c.created_at >= ? AND c.status NOT IN ('rejected','reversed')) AS today_reward
      FROM sources s ORDER BY s.key`).all(dayStart());

    return {
      sources: rows.map(s => ({
        key: s.key,
        name: s.name,
        glyph: s.glyph,
        color: s.color,
        mode: s.mode,
        pay: s.pay_cents,
        status: s.status,
        offerCount: s.offer_count,
        todayReward: s.today_reward,
        margin: s.pay_cents > 0 ? Math.round((s.pay_cents - Math.round(s.pay_cents * 0.74)) / s.pay_cents * 1000) / 10 : 0,
        crawlType: s.crawl_type || 'manual',
        crawlConfig: s.crawl_config ? JSON.parse(s.crawl_config) : null,
        defaultPay: s.default_pay_cents || 0,
        homepage: s.homepage || null,
        lastCrawledAt: s.last_crawled_at || null
      }))
    };
  });

  router.patch('/api/admin/sources/:key', async ctx => {
    requirePermission(ctx, "source:manage");
    const body = ctx.body || {};
    const key = ctx.params.key;

    const src = db.prepare('SELECT * FROM sources WHERE key = ?').get(key);
    if (!src) throw new HttpError(404, 'not_found', '题源不存在');

    const sets = [];
    const args = [];

    if (body.status !== undefined) {
      if (!['active', 'limited', 'paused'].includes(body.status)) {
        throw new HttpError(400, 'bad_status', '状态只能是 active / limited / paused');
      }
      sets.push('status = ?');
      args.push(body.status);
    }

    if (body.crawl_type !== undefined) {
      if (!['manual', 'adapter'].includes(body.crawl_type)) {
        throw new HttpError(400, 'bad_crawl_type', '抓取方式只能是 manual / adapter');
      }
      sets.push('crawl_type = ?');
      args.push(body.crawl_type);
    }

    if (body.crawl_config !== undefined) {
      if (body.crawl_config !== null && typeof body.crawl_config !== 'object') {
        throw new HttpError(400, 'bad_config', '抓取配置必须是对象或 null');
      }
      sets.push('crawl_config = ?');
      args.push(body.crawl_config ? JSON.stringify(body.crawl_config) : null);
    }

    if (body.default_pay_cents !== undefined) {
      const v = Number(body.default_pay_cents);
      if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'bad_pay', '默认单价必须是非负整数（分）');
      sets.push('default_pay_cents = ?');
      args.push(v);
    }

    if (body.homepage !== undefined) {
      sets.push('homepage = ?');
      args.push(body.homepage || null);
    }

    if (sets.length === 0) throw new HttpError(400, 'nothing_to_update', '没有可更新的字段');

    args.push(key);
    const before = { status: src.status, crawl_type: src.crawl_type, default_pay_cents: src.default_pay_cents };
    db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE key = ?`).run(...args);

    const updated = db.prepare('SELECT * FROM sources WHERE key = ?').get(key);
    audit.fromCtx(ctx, {
      action: 'source.update',
      target: `source:${key}`,
      detail: {
        before,
        after: { status: updated.status, crawl_type: updated.crawl_type, default_pay_cents: updated.default_pay_cents },
        // 密钥类配置只记「改过」，不把明文写进审计表
        configChanged: body.crawl_config !== undefined
      }
    });
    return {
      key,
      source: {
        key: updated.key,
        name: updated.name,
        status: updated.status,
        crawlType: updated.crawl_type,
        crawlConfig: updated.crawl_config ? JSON.parse(updated.crawl_config) : null,
        defaultPay: updated.default_pay_cents,
        homepage: updated.homepage,
        lastCrawledAt: updated.last_crawled_at
      }
    };
  });

  // ---- 题源抓取 ----

  /** 抓取面板：适配器能力 + 抓取统计 + 待审任务 + 最近日志 */
  router.get('/api/admin/crawl', async ctx => {
    requirePermission(ctx, "crawl:view");
    const stats = crawler.crawlStats();
    const pending = crawler.listPending({ limit: 60 });
    const logs = crawler.listLogs({ limit: 10 });

    return {
      adapters: crawler.listAdapters(),
      stats,
      pending: pending.map(o => ({
        id: o.id,
        title: o.title,
        externalUrl: o.external_url,
        externalId: o.external_id,
        category: o.category,
        reward: o.reward_cents,
        minutes: o.minutes,
        tags: JSON.parse(o.tags_json || '[]'),
        fetchedAt: o.fetched_at,
        source: { key: o.source_key, name: o.source_name, glyph: o.source_glyph, color: o.source_color }
      })),
      logs: logs.map(l => ({
        id: l.id,
        sourceKey: l.source_key,
        adapter: l.adapter,
        status: l.status,
        pages: l.pages,
        found: l.found,
        inserted: l.inserted,
        updated: l.updated,
        skipped: l.skipped,
        durationMs: l.duration_ms,
        error: l.error,
        createdAt: l.created_at
      }))
    };
  });

  /**
   * 触发抓取。同步等结果返回（单源通常 2-5 秒），
   * 前端拿到的就是本次抓取的统计，不需要再轮询。
   */
  router.post('/api/admin/crawl', async ctx => {
    requirePermission(ctx, "crawl:run");
    const { sourceKey, maxPages } = ctx.body || {};

    if (sourceKey) {
      const src = db.prepare('SELECT key, crawl_type FROM sources WHERE key = ?').get(sourceKey);
      if (!src) throw new HttpError(404, 'not_found', '题源不存在');
      if (src.crawl_type !== 'adapter') {
        throw new HttpError(400, 'not_crawlable', '该题源未开启抓取，请先配置抓取规则并设为 adapter');
      }
      const r = await crawler.runCrawl(sourceKey, { maxPages });
      audit.fromCtx(ctx, {
        action: 'crawl.run',
        target: `source:${sourceKey}`,
        detail: { inserted: r.inserted, updated: r.updated, skipped: r.skipped, pages: r.pages }
      });
      return { scope: 'single', result: r };
    }

    const r = await crawler.runAll({ maxPages });
    audit.fromCtx(ctx, { action: 'crawl.run_all', target: 'sources:*', detail: { summary: r } });
    return { scope: 'all', summary: r };
  });

  router.get('/api/admin/crawl-logs', async ctx => {
    requirePermission(ctx, "crawl:view");
    const sourceKey = ctx.query.get('source') || null;
    const limit = Number(ctx.query.get('limit') || 30);
    return {
      logs: crawler.listLogs({ sourceKey, limit }).map(l => ({
        id: l.id,
        sourceKey: l.source_key,
        adapter: l.adapter,
        status: l.status,
        pages: l.pages,
        found: l.found,
        inserted: l.inserted,
        updated: l.updated,
        skipped: l.skipped,
        durationMs: l.duration_ms,
        error: l.error,
        detail: JSON.parse(l.detail_json || '{}'),
        createdAt: l.created_at
      }))
    };
  });

  /** 审核爬取任务：上架（可顺带定价）或忽略 */
  router.post('/api/admin/offers/:id/review', async ctx => {
    requirePermission(ctx, "offer:review");
    const { action, reward, note } = ctx.body || {};
    if (!['approve', 'reject'].includes(action)) {
      throw new HttpError(400, 'bad_action', '动作只能是 approve / reject');
    }

    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(ctx.params.id);
    if (!offer) throw new HttpError(404, 'not_found', '问卷不存在');
    if (offer.origin !== 'crawled') throw new HttpError(400, 'not_crawled', '只能审核抓取来的任务');

    if (action === 'reject') {
      db.prepare("UPDATE offers SET status = 'closed', review_note = ? WHERE id = ?")
        .run(note || '运营忽略', offer.id);
      audit.fromCtx(ctx, {
        action: 'offer.reject',
        target: `offer:${offer.id}`,
        detail: { title: offer.title, note: note || '运营忽略' }
      });
      return { id: offer.id, status: 'closed' };
    }

    let rewardCents = offer.reward_cents;
    if (reward !== undefined && reward !== null && reward !== '') {
      const v = Number(reward);
      if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'bad_reward', '佣金必须是非负整数（分）');
      rewardCents = v;
    }
    if (rewardCents <= 0) {
      throw new HttpError(400, 'need_reward', '上架前必须设置佣金，请在审核时填写');
    }

    db.prepare("UPDATE offers SET status = 'open', reward_cents = ?, review_note = ? WHERE id = ?")
      .run(rewardCents, note || '审核通过', offer.id);

    audit.fromCtx(ctx, {
      action: 'offer.approve',
      target: `offer:${offer.id}`,
      detail: { title: offer.title, rewardBefore: offer.reward_cents, rewardAfter: rewardCents }
    });
    return { id: offer.id, status: 'open', reward: rewardCents };
  });

  router.get('/api/admin/offers', async ctx => {
    requirePermission(ctx, "offer:view");
    const rows = db.prepare(`
      SELECT o.*, s.name AS s_name, s.glyph AS s_glyph, s.color AS s_color,
        (SELECT COUNT(*) FROM commissions c WHERE c.offer_id = o.id AND c.status NOT IN ('rejected','reversed')) AS done_count
      FROM offers o JOIN sources s ON s.key = o.source_key ORDER BY o.reward_cents DESC`).all();
    return {
      offers: rows.map(o => ({
        id: o.id,
        title: o.title,
        source: { key: o.source_key, name: o.s_name, glyph: o.s_glyph, color: o.s_color },
        reward: o.reward_cents,
        pay: o.pay_cents,
        margin: o.pay_cents ? Math.round((o.pay_cents - o.reward_cents) / o.pay_cents * 1000) / 10 : 0,
        totalQuota: o.total_quota,
        leftQuota: o.left_quota,
        doneCount: o.done_count,
        status: o.status
      }))
    };
  });

  router.get('/api/admin/commissions', async ctx => {
    requirePermission(ctx, "commission:view");
    const status = ctx.query.get('status') || 'reviewing';
    const allowed = ['pending', 'reviewing', 'approved', 'available', 'rejected', 'reversed'];
    if (!allowed.includes(status)) throw new HttpError(400, 'bad_status', '未知状态');

    const rows = db.prepare(`
      SELECT c.*, o.title, o.source_key, u.name AS user_name, u.phone, u.credit_score,
             s.duration_ms, s.started_at, s.submitted_at,
             src.glyph, src.color
      FROM commissions c
      JOIN offers o ON o.id = c.offer_id
      JOIN sources src ON src.key = o.source_key
      JOIN users u ON u.id = c.user_id
      LEFT JOIN sessions s ON s.id = c.session_id
      WHERE c.status = ?
      ORDER BY c.created_at ASC LIMIT 100`).all(status);

    return {
      status,
      commissions: rows.map(c => ({
        id: c.id,
        transactionId: c.transaction_id,
        title: c.title,
        user: { id: c.user_id, name: c.user_name, phone: c.phone, creditScore: c.credit_score },
        reward: c.reward_cents,
        pay: c.pay_cents,
        status: c.status,
        flags: JSON.parse(c.flags_json),
        durationMs: c.duration_ms,
        createdAt: c.created_at,
        source: { key: c.source_key, glyph: c.glyph, color: c.color }
      }))
    };
  });

  router.post('/api/admin/commissions/:id/review', async ctx => {
    const admin = requirePermission(ctx, "commission:review");
    const { action, note } = ctx.body || {};
    if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'bad_action', 'action 只能是 approve / reject');
    const r = commission.review(ctx.params.id, { action, reviewer: admin.name, note: note || '' });
    if (!r.ok) throw new HttpError(409, r.reason, '该订单当前状态不允许复核');
    // 动钱的动作必须留痕：谁批的、批了多少、给了谁
    audit.fromCtx(ctx, {
      action: action === 'approve' ? 'commission.approve' : 'commission.reject',
      target: `commission:${r.commission.id}`,
      detail: {
        userId: r.commission.user_id,
        amount: r.commission.reward_cents,
        note: note || '',
        fromStatus: 'reviewing'
      }
    });
    return {
      id: r.commission.id,
      status: r.commission.status,
      wallet: wallet.getWallet(r.commission.user_id)
    };
  });

  router.post('/api/admin/commissions/bulk-approve', async ctx => {
    const admin = requirePermission(ctx, "commission:review");
    const rows = db.prepare("SELECT id FROM commissions WHERE status = 'reviewing' AND flags_json NOT LIKE '%device%'").all();
    let ok = 0;
    for (const r of rows) {
      const res = commission.review(r.id, { action: 'approve', reviewer: admin.name, note: '批量通过（低风险）' });
      if (res.ok) ok++;
    }
    audit.fromCtx(ctx, {
      action: 'commission.bulk_approve',
      target: `commissions:${ok}`,
      detail: { approved: ok, scanned: rows.length }
    });
    return { approved: ok };
  });

  router.get('/api/admin/risk-rules', async ctx => {
    requirePermission(ctx, "risk:view");
    return { rules: risk.listRules() };
  });

  router.patch('/api/admin/risk-rules/:key', async ctx => {
    requirePermission(ctx, "risk:manage");
    const { enabled } = ctx.body || {};
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'bad_payload', 'enabled 必须是布尔值');
    const before = db.prepare('SELECT enabled FROM risk_rules WHERE key = ?').get(ctx.params.key);
    const r = db.prepare('UPDATE risk_rules SET enabled = ? WHERE key = ?').run(enabled ? 1 : 0, ctx.params.key);
    if (r.changes === 0) throw new HttpError(404, 'not_found', '规则不存在');
    // 关掉一条风控等于放水，是后台最敏感的操作之一
    audit.fromCtx(ctx, {
      action: 'risk.rule_toggle',
      target: `risk_rule:${ctx.params.key}`,
      detail: { before: before ? !!before.enabled : null, after: enabled }
    });
    return { key: ctx.params.key, enabled };
  });

  router.post('/api/admin/settle', async ctx => {
    requirePermission(ctx, "settle:run");
    const r = commission.runSettlement();
    audit.fromCtx(ctx, { action: 'settle.run', target: 'commissions:pending', detail: r });
    return r;
  });

  router.get('/api/admin/risk-events', async ctx => {
    requirePermission(ctx, "risk:view");
    const rows = db.prepare(`
      SELECT e.*, u.name AS user_name, o.title, src.glyph, src.color
      FROM risk_events e
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN sessions s ON s.id = e.session_id
      LEFT JOIN offers o ON o.id = s.offer_id
      LEFT JOIN sources src ON src.key = o.source_key
      ORDER BY e.id DESC LIMIT 40`).all();
    return {
      events: rows.map(e => ({
        id: e.id,
        ruleKey: e.rule_key,
        detail: e.detail,
        user: e.user_name,
        title: e.title,
        glyph: e.glyph,
        color: e.color,
        createdAt: e.created_at
      }))
    };
  });

  router.get('/api/admin/postbacks', async ctx => {
    requirePermission(ctx, "postback:view");
    const rows = db.prepare('SELECT * FROM postback_logs ORDER BY id DESC LIMIT 30').all();
    return {
      postbacks: rows.map(p => ({
        id: p.id,
        sourceKey: p.source_key,
        transactionId: p.transaction_id,
        signValid: p.sign_valid === 1,
        result: p.result,
        createdAt: p.created_at
      }))
    };
  });

  // ---- 提现打款 ----

  /**
   * 用户提现只扣余额、落 pending，真正打款由财务在后台点。
   * 之前直接落 paid 是假的——没有资金流却标已支付，对账时对不上。
   */
  router.get('/api/admin/withdrawals', async ctx => {
    requirePermission(ctx, 'withdrawal:view');
    const status = ctx.query.get('status') || 'pending';
    const rows = db.prepare(`
      SELECT w.*, u.name AS user_name, u.phone, u.real_name
      FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE (? = 'all' OR w.status = ?)
      ORDER BY w.id DESC LIMIT 60`).all(status, status);

    return {
      stats: db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_cents END),0) AS pending_amount,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 END),0) AS pending_count,
          COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END),0) AS paid_amount
        FROM withdrawals`).get(),
      withdrawals: rows.map(w => ({
        id: w.id,
        userId: w.user_id,
        userName: w.user_name,
        phone: w.phone,
        realName: !!w.real_name,
        amount: w.amount_cents,
        channel: w.channel,
        status: w.status,
        createdAt: w.created_at,
        paidAt: w.paid_at
      }))
    };
  });

  router.patch('/api/admin/withdrawals/:id/pay', async ctx => {
    requirePermission(ctx, 'withdrawal:pay');
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(ctx.params.id);
    if (!w) throw new HttpError(404, 'not_found', '提现单不存在');
    if (w.status === 'paid') throw new HttpError(409, 'already_paid', '该笔已打款');
    if (w.status === 'failed') throw new HttpError(409, 'already_failed', '该笔已标记失败，请勿重复处理');

    const { action = 'pay', note } = ctx.body || {};
    if (!['pay', 'fail'].includes(action)) throw new HttpError(400, 'bad_action', '动作只能是 pay / fail');

    if (action === 'fail') {
      // 打款失败必须把钱退回可用余额，否则这笔钱就凭空消失了
      tx(() => {
        db.prepare("UPDATE withdrawals SET status = 'failed' WHERE id = ?").run(w.id);
        db.prepare('UPDATE wallets SET available_cents = available_cents + ? WHERE user_id = ?')
          .run(w.amount_cents, w.user_id);
        db.prepare(`INSERT INTO wallet_txns(user_id, kind, amount_cents, memo, ref_type, ref_id, created_at)
          VALUES(?,?,?,?,?,?,?)`)
          .run(w.user_id, 'adjust', w.amount_cents, '提现失败，金额退回', 'withdrawal', w.id, now());
      });
      audit.fromCtx(ctx, {
        action: 'withdrawal.fail',
        target: `withdrawal:${w.id}`,
        detail: { amount: w.amount_cents, userId: w.user_id, note: note || '', refunded: true }
      });
      return { id: w.id, status: 'failed', refunded: w.amount_cents };
    }

    db.prepare("UPDATE withdrawals SET status = 'paid', paid_at = ? WHERE id = ?").run(now(), w.id);
    audit.fromCtx(ctx, {
      action: 'withdrawal.pay',
      target: `withdrawal:${w.id}`,
      detail: { amount: w.amount_cents, userId: w.user_id, channel: w.channel, operator: ctx.user.name, note: note || '' }
    });
    return { id: w.id, status: 'paid', paidAt: now() };
  });

  // ---- 成员与权限 ----

  /** 角色与权限矩阵，供前端渲染下拉和说明 */
  router.get('/api/admin/roles', async ctx => {
    requirePermission(ctx, 'member:view');
    return {
      roles: Object.entries(ROLES).map(([key, def]) => ({
        key, label: def.label, level: def.level, permissions: permissionsOf(key)
      })),
      permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label }))
    };
  });

  router.get('/api/admin/members', async ctx => {
    requirePermission(ctx, 'member:view');
    const q = (ctx.query.get('q') || '').trim();
    const like = q ? `%${q}%` : null;
    const rows = db.prepare(`
      SELECT u.id, u.phone, u.name, u.role, u.status, u.credit_score, u.real_name,
             u.created_at, u.last_login_at, u.locked_until,
             (SELECT COUNT(*) FROM auth_sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
      FROM users u
      WHERE (? IS NULL OR u.name LIKE ? OR u.phone LIKE ?)
      ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'reviewer' THEN 1 WHEN 'finance' THEN 2 WHEN 'operator' THEN 3 ELSE 4 END,
               u.id DESC
      LIMIT 80`).all(now(), like, like, like);

    return {
      members: rows.map(u => ({
        id: u.id,
        phone: u.phone,
        name: u.name,
        role: u.role,
        roleLabel: ROLES[u.role] ? ROLES[u.role].label : u.role,
        status: u.status,
        realName: !!u.real_name,
        creditScore: u.credit_score,
        activeSessions: u.active_sessions,
        locked: !!(u.locked_until && new Date(u.locked_until).getTime() > Date.now()),
        lockedUntil: u.locked_until,
        lastLoginAt: u.last_login_at,
        createdAt: u.created_at
      })),
      stats: {
        total: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
        backend: db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role != 'user'`).get().c,
        disabled: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'disabled'").get().c,
        online: db.prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?').get(now()).c
      }
    };
  });

  /** 改角色 */
  router.patch('/api/admin/members/:id/role', async ctx => {
    const id = Number(ctx.params.id);
    const target = getUserById(id);
    if (!target) throw new HttpError(404, 'not_found', '成员不存在');
    const actor = assertCanManage(ctx, target);

    const { role } = ctx.body || {};
    if (!isValidRole(role)) throw new HttpError(400, 'bad_role', '角色不存在');
    if (role === target.role) return { id, role, changed: false };
    if (levelOf(role) >= levelOf(actor.role)) {
      throw new HttpError(403, 'forbidden', '不能把成员提升到与自己同级或更高');
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    // 角色变了，手里的旧令牌里还写着老角色，必须重新登录才能拿到新权限
    const killed = session.revokeAll(id, { reason: 'role_changed' });
    audit.fromCtx(ctx, {
      action: 'role.change',
      target: `user:${id}`,
      detail: { name: target.name, before: target.role, after: role, revokedSessions: killed }
    });
    return {
      id, role,
      roleLabel: ROLES[role].label,
      permissions: permissionsOf(role),
      revokedSessions: killed,
      changed: true
    };
  });

  /** 启用 / 禁用 */
  router.patch('/api/admin/members/:id/status', async ctx => {
    const id = Number(ctx.params.id);
    const target = getUserById(id);
    if (!target) throw new HttpError(404, 'not_found', '成员不存在');
    const actor = assertCanManage(ctx, target);

    const { status, remark } = ctx.body || {};
    if (!['active', 'disabled'].includes(status)) throw new HttpError(400, 'bad_status', '状态只能是 active / disabled');

    db.prepare('UPDATE users SET status = ?, remark = COALESCE(?, remark) WHERE id = ?')
      .run(status, remark || null, id);

    let killed = 0;
    if (status === 'disabled') {
      // 禁用必须同时踢下线，否则对方拿着旧令牌还能继续用满 12 小时
      killed = session.revokeAll(id, { reason: 'account_disabled' });
    }
    audit.fromCtx(ctx, {
      action: 'member.status',
      target: `user:${id}`,
      detail: { name: target.name, before: target.status, after: status, remark: remark || '', revokedSessions: killed }
    });
    return { id, status, revokedSessions: killed };
  });

  /** 解除登录锁定 */
  router.post('/api/admin/members/:id/unlock', async ctx => {
    requirePermission(ctx, 'member:manage');
    const id = Number(ctx.params.id);
    const target = getUserById(id);
    if (!target) throw new HttpError(404, 'not_found', '成员不存在');
    db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ?').run(id);
    audit.fromCtx(ctx, {
      action: 'member.unlock',
      target: `user:${id}`,
      detail: { name: target.name, lockedUntil: target.locked_until }
    });
    return { id, locked: false };
  });

  /** 强制该成员所有设备下线 */
  router.post('/api/admin/members/:id/logout', async ctx => {
    const id = Number(ctx.params.id);
    const target = getUserById(id);
    if (!target) throw new HttpError(404, 'not_found', '成员不存在');
    const actor = assertCanManage(ctx, target);
    const killed = session.revokeAll(id, { reason: `kicked_by:${actor.id}` });
    audit.fromCtx(ctx, {
      action: 'member.force_logout',
      target: `user:${id}`,
      detail: { name: target.name, revokedSessions: killed }
    });
    return { id, revokedSessions: killed };
  });

  // ---- 操作审计 ----

  router.get('/api/admin/audit-logs', async ctx => {
    requirePermission(ctx, 'audit:view');
    const limit = Math.min(200, Number(ctx.query.get('limit') || 50));
    const offset = Math.max(0, Number(ctx.query.get('offset') || 0));
    const data = audit.list({
      action: ctx.query.get('action') || null,
      actorId: ctx.query.get('actorId') || null,
      result: ctx.query.get('result') || null,
      limit, offset
    });
    return {
      ...data,
      summary: {
        denied24h: db.prepare(`SELECT COUNT(*) AS c FROM audit_logs
            WHERE result = 'denied' AND created_at >= ?`).get(new Date(Date.now() - 86400000).toISOString()).c,
        actions24h: db.prepare(`SELECT COUNT(*) AS c FROM audit_logs
            WHERE created_at >= ?`).get(new Date(Date.now() - 86400000).toISOString()).c
      }
    };
  });
};
