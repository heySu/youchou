'use strict';
/**
 * 接口集成测试：真实起服务、真实 SQLite、真实 HTTP。
 * 运行：npm test
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), 'youchou-test-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;
process.env.FREEZE_MS = '0';              // 测试里不等待冻结期
process.env.AUTO_POSTBACK = '0';          // 由用例显式驱动题源回调，避免竞态

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../server/index');
const { seed } = require('../server/seed');
const { db } = require('../server/db');
const { hmacSign } = require('../server/auth');

let server;
let BASE;
let adminToken;

async function call(p, { method = 'GET', body, token } = {}, legacyToken) {
  token = token || legacyToken;
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
async function newUser(name = '测试用户') {
  seq++;
  const phone = '199' + String(Date.now()).slice(-5) + String(seq).padStart(3, '0');
  const r = await call('/api/auth/register', { method: 'POST', body: { phone, password: 'demo123456', name } });
  assert.equal(r.status, 201, '注册应成功');
  return { token: r.data.token, user: r.data.user, phone };
}

/** 按题库生成「正常」答卷：选项打散，注意力题答对 */
function buildAnswers(offerId) {
  const row = db.prepare('SELECT questions_json FROM offers WHERE id = ?').get(offerId);
  const qs = JSON.parse(row.questions_json);
  let k = 0;
  return qs.map(q => {
    if (q.type === 'multi') return [0, 1].slice(0, Math.min(2, q.opts.length));
    if (q.type === 'text') return '这是一条测试回答内容';
    if (q.attn) return q.opts.indexOf(q.attentionAnswer);
    return (k++ % Math.min(4, q.opts.length));
  });
}

/** 极速敷衍答卷：单选/量表全选第一项，多选一项，文本凑字数 */
function fastAnswers(offerId) {
  const qs = JSON.parse(db.prepare('SELECT questions_json FROM offers WHERE id = ?').get(offerId).questions_json);
  return qs.map(q => (q.type === 'multi' ? [0] : q.type === 'text' ? '测试回答' : 0));
}

/** 以题源身份发一次合法回调 */
async function postbackFor(commissionId, { status = 'complete', payout = 10 } = {}) {
  const c = db.prepare(`
    SELECT c.transaction_id, c.offer_id, c.user_id, o.source_key, s.secret
    FROM commissions c JOIN offers o ON o.id = c.offer_id
    JOIN sources s ON s.key = o.source_key WHERE c.id = ?`).get(commissionId);
  const params = {
    transaction_id: c.transaction_id,
    survey_id: c.offer_id,
    user_ref: String(c.user_id),
    status,
    payout,
    currency: 'CNY',
    timestamp: Math.floor(Date.now() / 1000)
  };
  return call('/api/postback/' + c.source_key, {
    method: 'POST',
    body: { ...params, signature: hmacSign(c.secret, params) }
  });
}

/** 完整走完一份问卷（把会话时间回拨，绕过答题速度规则） */
async function completeClean(user, offerId) {
  const s = await call('/api/sessions', { method: 'POST', body: { offerId }, token: user.token });
  assert.equal(s.status, 200, '开题应成功: ' + JSON.stringify(s.data));
  const sessionId = s.data.sessionId;
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 300000).toISOString(), sessionId);
  const r = await call('/api/responses', {
    method: 'POST',
    body: { sessionId, answers: buildAnswers(offerId) },
    token: user.token
  });
  assert.equal(r.status, 200, '提交应成功: ' + JSON.stringify(r.data));
  return r.data;
}

before(async () => {
  seed({ reset: true, quiet: true, withHistory: false });
  server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;

  const r = await call('/api/auth/login', { method: 'POST', body: { phone: 'admin', password: 'admin12345' } });
  adminToken = r.data.token;
});

after(async () => {
  await new Promise(r => server.close(r));
  try { fs.unlinkSync(TMP_DB); } catch (_) {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch (_) {}
});

/* ------------------------------------------------------------------ */

test('健康检查与未登录访问', async () => {
  const h = await call('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);

  const r = await call('/api/offers');
  assert.equal(r.status, 401);
  assert.equal(r.data.error.code, 'unauthorized');
});

test('注册 / 重复注册 / 错误密码', async () => {
  const u = await newUser();
  assert.ok(u.token);

  const dup = await call('/api/auth/register', { method: 'POST', body: { phone: u.phone, password: 'demo123456' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'phone_taken');

  const bad = await call('/api/auth/login', { method: 'POST', body: { phone: u.phone, password: 'wrong' } });
  assert.equal(bad.status, 401);

  const weak = await call('/api/auth/register', { method: 'POST', body: { phone: '19900000001', password: '123' } });
  assert.equal(weak.status, 400);
});

test('问卷池：含题源信息、不泄露风控答案、暂停题源不出现', async () => {
  const u = await newUser();
  const r = await call('/api/offers', {}, u.token);
  assert.equal(r.status, 200);
  assert.ok(r.data.offers.length >= 7);
  assert.ok(!r.data.offers.some(o => o.source.key === 'sp'), 'paused 题源（Spotify）不应出现');
  assert.ok(!('pay' in r.data.offers[0]), '不能把结算价泄露给用户端');

  const detail = await call('/api/offers/sx-106', {}, u.token);
  const raw = JSON.stringify(detail.data);
  assert.ok(!raw.includes('attentionAnswer'), '注意力题答案不能在接口里出现');
});

test('开题锁配额，重复开题被拒绝', async () => {
  const u = await newUser();
  const before = db.prepare('SELECT left_quota FROM offers WHERE id = ?').get('sx-107').left_quota;

  const s = await call('/api/sessions', { method: 'POST', body: { offerId: 'sx-107' }, token: u.token });
  assert.equal(s.status, 200);
  assert.equal(s.data.offer.questions.length, 6);

  const afterQuota = db.prepare('SELECT left_quota FROM offers WHERE id = ?').get('sx-107').left_quota;
  assert.equal(afterQuota, before - 1, '开题应扣减配额');

  // 同一用户再次开同一份问卷：尚未提交，仍允许（重进），但提交后再开要被拒
  const r = await call('/api/responses', {
    method: 'POST',
    body: { sessionId: s.data.sessionId, answers: buildAnswers('sx-107') },
    token: u.token
  });
  assert.equal(r.status, 200);

  const again = await call('/api/sessions', { method: 'POST', body: { offerId: 'sx-107' }, token: u.token });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'already_completed');
});

test('提交答卷：服务端计时 + 风控命中答题过快', async () => {
  const u = await newUser();
  const s = await call('/api/sessions', { method: 'POST', body: { offerId: 'sx-105' }, token: u.token });
  const answers = fastAnswers('sx-105');

  const r = await call('/api/responses', {
    method: 'POST',
    body: { sessionId: s.data.sessionId, answers },
    token: u.token
  });

  assert.equal(r.status, 200);
  assert.equal(r.data.commission.status, 'reviewing', '极速提交应转人工复核');
  assert.ok(r.data.commission.flags.some(f => f.key === 'speed'));
  assert.ok(r.data.durationMs < 20000, '时长由服务端计算，应为毫秒级');
  assert.equal(r.data.wallet.available, 0, '复核中的佣金不能进可用余额');
  assert.equal(r.data.wallet.pending, r.data.commission.reward);
});

test('注意力校验题答错会被拦截', async () => {
  const u = await newUser();
  const s = await call('/api/sessions', { method: 'POST', body: { offerId: 'sx-104' }, token: u.token });
  const answers = buildAnswers('sx-104');
  const qs = JSON.parse(db.prepare('SELECT questions_json FROM offers WHERE id = ?').get('sx-104').questions_json);
  const idx = qs.findIndex(q => q.attn);
  answers[idx] = 0; // 故意选「非常不同意」

  const r = await call('/api/responses', {
    method: 'POST',
    body: { sessionId: s.data.sessionId, answers },
    token: u.token
  });
  assert.equal(r.data.commission.status, 'reviewing');
  assert.ok(r.data.commission.flags.some(f => f.key === 'attention'), '应命中注意力规则');
});

test('非法答卷被拒（题数不符 / 选项越界 / 空文本）', async () => {
  const u = await newUser();
  const s = await call('/api/sessions', { method: 'POST', body: { offerId: 'sx-103' }, token: u.token });
  const answers = buildAnswers('sx-103');

  const short = await call('/api/responses', {
    method: 'POST', body: { sessionId: s.data.sessionId, answers: answers.slice(0, 2) }, token: u.token
  });
  assert.equal(short.status, 400);
  assert.equal(short.data.error.code, 'invalid_answers');

  const oob = answers.slice();
  oob[0] = 99;
  const r2 = await call('/api/responses', { method: 'POST', body: { sessionId: s.data.sessionId, answers: oob }, token: u.token });
  assert.equal(r2.status, 400);
});

test('干净答卷：pending → Postback 确认 approved → 解冻 available', async () => {
  const u = await newUser();
  const data = await completeClean(u, 'sx-106');
  assert.equal(data.commission.status, 'pending', '干净答卷应直接进入待结算');
  assert.equal(data.commission.flags.length, 0);

  const pb = await postbackFor(data.commission.id, { payout: 24.3 });
  assert.equal(pb.status, 200);
  assert.equal(pb.data.result, 'approved', 'Postback 后应变为 approved');

  const c1 = await call('/api/commissions', {}, u.token);
  const cm = c1.data.commissions.find(x => x.id === data.commission.id);
  assert.equal(cm.status, 'approved');

  const settle = await call('/api/admin/settle', { method: 'POST' }, adminToken);
  assert.ok(settle.data.released >= 1, '结算任务应解冻至少 1 笔');

  const c2 = await call('/api/commissions', {}, u.token);
  const cm2 = c2.data.commissions.find(x => x.id === data.commission.id);
  assert.equal(cm2.status, 'available', '冻结期后应可提现');

  const w = await call('/api/wallet', {}, u.token);
  assert.equal(w.data.available, 1800);
  assert.equal(w.data.pending, 0);
});

test('Postback 验签失败被拒绝，且不改变佣金状态', async () => {
  const u = await newUser();
  const data = await completeClean(u, 'sx-103');
  const txn = db.prepare('SELECT transaction_id FROM commissions WHERE id = ?').get(data.commission.id).transaction_id;

  const payload = {
    transaction_id: txn, survey_id: 'sx-103', user_ref: String(u.user.id),
    status: 'complete', payout: 5.7, currency: 'CNY', timestamp: Math.floor(Date.now() / 1000),
    signature: 'deadbeef'
  };
  const r = await call('/api/postback/yahoo', { method: 'POST', body: payload });
  assert.equal(r.status, 401);
  assert.equal(r.data.error.code, 'invalid_signature');

  const st = db.prepare('SELECT status FROM commissions WHERE id = ?').get(data.commission.id).status;
  assert.equal(st, 'pending', '验签失败不得推进状态');

  const logRow = db.prepare("SELECT COUNT(*) AS c FROM postback_logs WHERE result = 'invalid_signature'").get();
  assert.ok(logRow.c >= 1, '应留下回调日志');
});

test('Postback 幂等：重复回调不重复入账', async () => {
  const u = await newUser();
  const data = await completeClean(u, 'sx-105');
  const c = db.prepare('SELECT * FROM commissions WHERE id = ?').get(data.commission.id);

  const secret = db.prepare("SELECT secret FROM sources WHERE key = 'tt'").get().secret;
  const params = {
    transaction_id: c.transaction_id, survey_id: c.offer_id, user_ref: String(u.user.id),
    status: 'complete', payout: 4.9, currency: 'CNY', timestamp: Math.floor(Date.now() / 1000)
  };
  const body = { ...params, signature: hmacSign(secret, params) };

  const first = await call('/api/postback/tt', { method: 'POST', body });
  assert.equal(first.status, 200);
  assert.equal(first.data.result, 'approved');

  const walletAfterFirst = (await call('/api/wallet', {}, u.token)).data;

  const second = await call('/api/postback/tt', { method: 'POST', body });
  assert.equal(second.status, 200, '重复回调必须返回 200，避免题源无限重试');
  assert.equal(second.data.result, 'duplicate');

  const walletAfterSecond = (await call('/api/wallet', {}, u.token)).data;
  assert.equal(walletAfterSecond.total, walletAfterFirst.total, '重复回调不得重复计钱');
});

test('人工复核：通过 / 驳回 / 状态约束', async () => {
  const u = await newUser();

  // 造一笔复核单
  const s = await call('/api/sessions', { method: 'POST', body: { offerId: 'sx-107' }, token: u.token });
  const fast = await call('/api/responses', {
    method: 'POST',
    body: { sessionId: s.data.sessionId, answers: fastAnswers('sx-107') },
    token: u.token
  });
  const cid = fast.data.commission.id;
  assert.equal(fast.data.commission.status, 'reviewing');

  const queue = await call('/api/admin/commissions?status=reviewing', {}, adminToken);
  assert.ok(queue.data.commissions.some(c => c.id === cid), '复核单应出现在待审队列');

  const approve = await call(`/api/admin/commissions/${cid}/review`, { method: 'POST', body: { action: 'approve' } }, adminToken);
  assert.equal(approve.status, 200);
  assert.equal(approve.data.status, 'approved');

  const twice = await call(`/api/admin/commissions/${cid}/review`, { method: 'POST', body: { action: 'approve' } }, adminToken);
  assert.equal(twice.status, 409, '同一单不能重复审核');

  // 驳回：佣金回滚 + 配额返还
  const u2 = await newUser();
  const s2 = await call('/api/sessions', { method: 'POST', body: { offerId: 'sx-101' }, token: u2.token });
  const fast2 = await call('/api/responses', {
    method: 'POST',
    body: { sessionId: s2.data.sessionId, answers: fastAnswers('sx-101') },
    token: u2.token
  });
  const quotaBefore = db.prepare('SELECT left_quota FROM offers WHERE id = ?').get('sx-101').left_quota;
  const reject = await call(`/api/admin/commissions/${fast2.data.commission.id}/review`, { method: 'POST', body: { action: 'reject', note: '质量不合格' } }, adminToken);
  assert.equal(reject.data.status, 'rejected');

  const w = await call('/api/wallet', {}, u2.token);
  assert.equal(w.data.pending, 0, '驳回后冻结金额应清零');
  assert.equal(w.data.total, 0, '驳回后累计收益应扣回');

  const quotaAfter = db.prepare('SELECT left_quota FROM offers WHERE id = ?').get('sx-101').left_quota;
  assert.equal(quotaAfter, quotaBefore + 1, '驳回应返还配额');
});

test('提现：门槛、余额、额度、成功后扣减', async () => {
  const u = await newUser();
  const a1 = await completeClean(u, 'sx-106'); // 1800
  const a2 = await completeClean(u, 'sx-103'); // 420
  await postbackFor(a1.commission.id);
  await postbackFor(a2.commission.id);
  await call('/api/admin/settle', { method: 'POST' }, adminToken);

  // 未实名不能提现
  const noName = await call('/api/withdrawals', { method: 'POST', body: { amount: 2000, channel: 'wechat' } }, u.token);
  assert.equal(noName.status, 403);
  assert.equal(noName.data.error.code, 'need_realname');

  const rn = await call('/api/me/realname', { method: 'POST', body: { name: '测试用户', idNumber: '110101199001011234' } }, u.token);
  assert.equal(rn.status, 200);

  const w = await call('/api/wallet', {}, u.token);
  assert.equal(w.data.available, 2220);

  const low = await call('/api/withdrawals', { method: 'POST', body: { amount: 100, channel: 'wechat' } }, u.token);
  assert.equal(low.status, 400);
  assert.equal(low.data.error.code, 'below_min');

  const over = await call('/api/withdrawals', { method: 'POST', body: { amount: 999999, channel: 'wechat' } }, u.token);
  assert.equal(over.status, 400);

  const badChannel = await call('/api/withdrawals', { method: 'POST', body: { amount: 2000, channel: 'paypal' } }, u.token);
  assert.equal(badChannel.status, 400);

  const ok = await call('/api/withdrawals', { method: 'POST', body: { amount: 2000, channel: 'wechat' } }, u.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.wallet.available, 220);

  const again = await call('/api/withdrawals', { method: 'POST', body: { amount: 2000, channel: 'wechat' } }, u.token);
  assert.equal(again.status, 400);
  assert.equal(again.data.error.code, 'insufficient');
});

test('账本不变式：余额自洽、流水与提现一致', async () => {
  const users = db.prepare('SELECT user_id FROM wallets').all();
  assert.ok(users.length > 0);
  for (const { user_id } of users) {
    const w = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user_id);
    const withdrawn = w.total_cents - w.available_cents - w.pending_cents;

    assert.ok(w.available_cents >= 0, `用户 ${user_id} 可用余额为负`);
    assert.ok(w.pending_cents >= 0, `用户 ${user_id} 冻结金额为负`);
    assert.ok(withdrawn >= 0, `用户 ${user_id} 提现金额为负`);
    assert.equal(w.available_cents + w.pending_cents + withdrawn, w.total_cents, `用户 ${user_id} 账本不平`);

    // 已提现额度必须与流水中的提现笔数总额一致
    const out = Math.abs(db.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS s FROM wallet_txns WHERE user_id = ? AND kind = 'withdraw_out'"
    ).get(user_id).s);
    assert.equal(withdrawn, out, `用户 ${user_id} 提现流水与余额不一致`);

    // 累计收益 = 未驳回佣金 + 调整项
    const rewards = db.prepare(
      "SELECT COALESCE(SUM(reward_cents),0) AS s FROM commissions WHERE user_id = ? AND status NOT IN ('rejected','reversed')"
    ).get(user_id).s;
    const adjust = db.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS s FROM wallet_txns WHERE user_id = ? AND kind = 'adjust'"
    ).get(user_id).s;
    assert.equal(w.total_cents, rewards + adjust, `用户 ${user_id} 累计收益与佣金总额不符`);
  }
});

test('权限隔离：普通用户不能访问后台', async () => {
  const u = await newUser();
  const r = await call('/api/admin/overview', {}, u.token);
  assert.equal(r.status, 403);

  const r2 = await call('/api/admin/commissions?status=reviewing', {}, u.token);
  assert.equal(r2.status, 403);

  const anon = await call('/api/admin/overview');
  assert.equal(anon.status, 401);
});

test('后台概览与风控规则可读写', async () => {
  const ov = await call('/api/admin/overview', {}, adminToken);
  assert.equal(ov.status, 200);
  assert.ok(ov.data.today.completed >= 1);
  assert.ok(ov.data.today.margin >= 0);

  const rules = await call('/api/admin/risk-rules', {}, adminToken);
  assert.equal(rules.data.rules.length, 5);

  const off = await call('/api/admin/risk-rules/speed', { method: 'PATCH', body: { enabled: false } }, adminToken);
  assert.equal(off.data.enabled, false);

  // 关闭速度规则后，极速提交不再命中 speed
  const u = await newUser();
  const s = await call('/api/sessions', { method: 'POST', body: { offerId: 'sx-105' }, token: u.token });
  const r = await call('/api/responses', {
    method: 'POST',
    body: { sessionId: s.data.sessionId, answers: buildAnswers('sx-105') },
    token: u.token
  });
  assert.ok(!r.data.commission.flags.some(f => f.key === 'speed'), '规则关闭后不应再命中');

  await call('/api/admin/risk-rules/speed', { method: 'PATCH', body: { enabled: true } }, adminToken);
});
