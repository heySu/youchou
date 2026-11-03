'use strict';
/**
 * 权限与会话测试。
 * 覆盖四件事：角色能做什么、会话能否吊销、登录失败如何处理、动钱动权限是否留痕。
 * 运行：npm test
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), 'youchou-auth-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;
process.env.FREEZE_MS = '0';
process.env.AUTO_POSTBACK = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../server/index');
const { seed } = require('../server/seed');
const { db } = require('../server/db');

let server;
let BASE;
const T = {};   // 各角色 token
let seq = 0;

async function call(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function login(phone, password, admin = true) {
  return call('/api/auth/login', { method: 'POST', body: { phone, password, admin } });
}

async function newMember(name = '权限测试') {
  seq++;
  const phone = '188' + String(Date.now()).slice(-5) + String(seq).padStart(3, '0');
  const r = await call('/api/auth/register', { method: 'POST', body: { phone, password: 'abc12345', name } });
  assert.equal(r.status, 201, '注册应成功: ' + JSON.stringify(r.data));
  return { phone, id: r.data.user.id, token: r.data.token };
}

before(async () => {
  seed({ reset: true, quiet: true, withHistory: false });
  server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;

  for (const [key, phone, pw] of [
    ['admin', 'admin', 'admin12345'],
    ['operator', 'operator', 'op123456'],
    ['reviewer', 'reviewer', 'rv123456'],
    ['finance', 'finance', 'fn123456']
  ]) {
    const r = await login(phone, pw);
    assert.equal(r.status, 200, key + ' 应能登录: ' + JSON.stringify(r.data));
    T[key] = r.data.token;
  }
  const u = await login('13800000001', 'demo123456', false);
  T.user = u.data.token;
});

after(async () => {
  await new Promise(r => server.close(r));
  try { fs.unlinkSync(TMP_DB); } catch (_) {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch (_) {}
});

/* ---------------- 角色与权限 ---------------- */

test('登录返回展开后的权限清单，超管拿全量', async () => {
  const r = await login('admin', 'admin12345');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
  assert.equal(r.data.user.roleLabel, '超级管理员');
  assert.ok(r.data.user.permissions.includes('member:manage'));
  assert.ok(r.data.user.permissions.includes('settle:run'));
  assert.ok(r.data.user.permissions.length >= 15, '超管应拿到全部权限点');
  assert.ok(r.data.sessionExpiresAt, '应返回会话到期时间');
});

test('各角色权限边界：职责分离确实生效', async () => {
  const op = (await login('operator', 'op123456')).data.user.permissions;
  const rv = (await login('reviewer', 'rv123456')).data.user.permissions;
  const fn = (await login('finance', 'fn123456')).data.user.permissions;

  // 运营：管题源与上架，不碰钱
  assert.ok(op.includes('source:manage') && op.includes('crawl:run') && op.includes('offer:review'));
  assert.ok(!op.includes('settle:run'), '运营不能执行结算');
  assert.ok(!op.includes('withdrawal:pay'), '运营不能打款');
  assert.ok(!op.includes('member:manage'), '运营不能改成员角色');

  // 审核：能复核佣金，不能打款、不能改风控
  assert.ok(rv.includes('commission:review'));
  assert.ok(!rv.includes('withdrawal:pay'), '审核员不能打款');
  assert.ok(!rv.includes('risk:manage'), '审核员不能改风控规则');

  // 财务：能打款与结算，不能复核佣金
  assert.ok(fn.includes('withdrawal:pay') && fn.includes('settle:run'));
  assert.ok(!fn.includes('commission:review'), '财务不能复核佣金（否则等于自己批自己付）');
  assert.ok(!fn.includes('member:manage'));
});

test('权限矩阵：越权请求一律 403，且写入审计', async () => {
  const before = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE result = 'denied'").get().c;

  const cases = [
    ['operator', 'POST', '/api/admin/settle', {}, 'settle:run'],
    ['operator', 'PATCH', '/api/admin/risk-rules/straightline', { enabled: false }, 'risk:manage'],
    ['operator', 'GET', '/api/admin/audit-logs', null, 'audit:view'],
    ['reviewer', 'POST', '/api/admin/settle', {}, 'settle:run'],
    ['reviewer', 'PATCH', '/api/admin/withdrawals/wd_x/pay', {}, 'withdrawal:pay'],
    ['reviewer', 'POST', '/api/admin/offers/sx-101/review', { action: 'approve', reward: 800 }, 'offer:review'],
    ['finance', 'GET', '/api/admin/risk-events', null, 'risk:view'],
    ['finance', 'PATCH', '/api/admin/members/2/role', { role: 'admin' }, 'member:manage'],
    ['user', 'GET', '/api/admin/overview', null, null]
  ];

  for (const [who, method, p, body, need] of cases) {
    const r = await call(p, { method, body, token: T[who] });
    assert.equal(r.status, 403, `${who} ${method} ${p} 应被拒绝，实际 ${r.status}`);
    assert.equal(r.data.error.code, 'forbidden');
    if (need) {
      const row = db.prepare(`SELECT * FROM audit_logs WHERE result = 'denied' AND action = 'auth.denied'
        ORDER BY id DESC LIMIT 1`).get();
      assert.ok(row, '越权应写入审计');
      assert.equal(JSON.parse(row.detail_json).need, need);
    }
  }

  const afterCount = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE result = 'denied'").get().c;
  assert.equal(afterCount - before, cases.length, '每次越权都应留一条审计');
});

test('有权限的请求正常放行', async () => {
  const ok = [
    ['admin', 'GET', '/api/admin/overview', null],
    ['admin', 'GET', '/api/admin/members', null],
    ['admin', 'GET', '/api/admin/audit-logs', null],
    ['admin', 'GET', '/api/admin/withdrawals?status=all', null],
    ['operator', 'GET', '/api/admin/crawl', null],
    ['reviewer', 'GET', '/api/admin/commissions', null],
    ['finance', 'GET', '/api/admin/withdrawals?status=all', null]
  ];
  for (const [who, method, p, body] of ok) {
    const r = await call(p, { method, body, token: T[who] });
    assert.equal(r.status, 200, `${who} ${p} 应放行，实际 ${r.status} ${JSON.stringify(r.data)}`);
  }
});

test('概览只依赖 dashboard:view，财务能看到且不触发 source:view', async () => {
  const deniedBefore = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'auth.denied'").get().c;
  const r = await call('/api/admin/overview', { token: T.finance });
  assert.equal(r.status, 200, '财务应能看概览: ' + JSON.stringify(r.data));
  assert.ok(Array.isArray(r.data.sourcePerf) && r.data.sourcePerf.length > 0, '概览应自带题源表现');
  assert.ok(Array.isArray(r.data.recentPostbacks), '概览应自带最近回调');

  const deniedAfter = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'auth.denied'").get().c;
  assert.equal(deniedAfter, deniedBefore, '看首页不应产生越权记录');
});

/* ---------------- 普通用户不能进后台 ---------------- */

test('普通用户走后台入口被拒，且不能调用后台接口', async () => {
  const r = await login('13800000001', 'demo123456', true);
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'forbidden');

  const me = await call('/api/me', { token: T.user });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.permissions.length, 0, '普通用户没有任何后台权限');
});

/* ---------------- 会话 ---------------- */

test('会话可吊销：踢掉某台设备后旧令牌立即失效', async () => {
  const a = await login('reviewer', 'rv123456');
  const b = await login('reviewer', 'rv123456');

  const list = await call('/api/auth/sessions', { token: a.data.token });
  assert.equal(list.status, 200);
  assert.ok(list.data.sessions.length >= 2);

  const other = list.data.sessions.find(s => !s.current);
  assert.ok(other, '应能找到另一台设备');

  const kick = await call('/api/auth/sessions/' + other.id, { method: 'DELETE', token: a.data.token });
  assert.equal(kick.status, 200);

  const dead = await call('/api/me', { token: b.data.token });
  assert.equal(dead.status, 401, '被踢设备的令牌应失效');

  const alive = await call('/api/me', { token: a.data.token });
  assert.equal(alive.status, 200, '当前设备不受影响');
});

test('改密码后其他设备全部下线，旧密码失效', async () => {
  const m = await newMember('改密测试');
  const other = await login(m.phone, 'abc12345', false);
  assert.equal(other.status, 200);

  const chg = await call('/api/auth/password', {
    method: 'POST',
    body: { oldPassword: 'abc12345', newPassword: 'xyz98765' },
    token: m.token
  });
  assert.equal(chg.status, 200);
  assert.equal(chg.data.revokedSessions, 1, '应踢掉另一台设备');

  const dead = await call('/api/me', { token: other.data.token });
  assert.equal(dead.status, 401);

  const alive = await call('/api/me', { token: m.token });
  assert.equal(alive.status, 200, '改密码的当前设备应保留');

  assert.equal((await login(m.phone, 'abc12345', false)).status, 401, '旧密码不能再登录');
  assert.equal((await login(m.phone, 'xyz98765', false)).status, 200, '新密码可登录');
});

test('弱口令与相同密码被拒', async () => {
  const m = await newMember('弱口令测试');
  const weak = await call('/api/auth/password', {
    method: 'POST', body: { oldPassword: 'abc12345', newPassword: '12345678' }, token: m.token
  });
  assert.equal(weak.status, 400);
  assert.equal(weak.data.error.code, 'weak_password');

  const same = await call('/api/auth/password', {
    method: 'POST', body: { oldPassword: 'abc12345', newPassword: 'abc12345' }, token: m.token
  });
  assert.equal(same.status, 400);
  assert.equal(same.data.error.code, 'same_password');

  const wrongOld = await call('/api/auth/password', {
    method: 'POST', body: { oldPassword: 'nope-nope', newPassword: 'xyz98765' }, token: m.token
  });
  assert.equal(wrongOld.status, 400);
  assert.equal(wrongOld.data.error.code, 'bad_old_password');
});

test('登录失败 5 次锁定 15 分钟，正确密码也进不去；管理员可解锁', async () => {
  const m = await newMember('锁定测试');

  for (let i = 1; i <= 5; i++) {
    const r = await login(m.phone, 'wrong-pass', false);
    assert.equal(r.status, 401, `第 ${i} 次应 401`);
  }

  const locked = await login(m.phone, 'abc12345', false);
  assert.equal(locked.status, 429, '锁定后即使密码正确也应 429');
  assert.equal(locked.data.error.code, 'account_locked');
  assert.ok(locked.data.error.retryAfter > 0, '应返回剩余锁定秒数');

  const unlock = await call('/api/admin/members/' + m.id + '/unlock', { method: 'POST', token: T.admin });
  assert.equal(unlock.status, 200);

  const back = await login(m.phone, 'abc12345', false);
  assert.equal(back.status, 200, '解锁后应能登录');
});

/* ---------------- 成员管理 ---------------- */

test('改角色立即生效并踢下线；不能操作自己或超管', async () => {
  const m = await newMember('角色变更测试');

  const promote = await call('/api/admin/members/' + m.id + '/role', {
    method: 'PATCH', body: { role: 'reviewer' }, token: T.admin
  });
  assert.equal(promote.status, 200);
  assert.equal(promote.data.role, 'reviewer');
  assert.ok(promote.data.permissions.includes('commission:review'));

  const dead = await call('/api/me', { token: m.token });
  assert.equal(dead.status, 401, '改角色后旧令牌应失效');

  const relogin = await login(m.phone, 'abc12345', true);
  assert.equal(relogin.status, 200);
  assert.ok(relogin.data.user.permissions.includes('commission:review'), '新令牌应带新权限');

  // 不能改自己
  const self = await call('/api/admin/members/1/role', { method: 'PATCH', body: { role: 'operator' }, token: T.admin });
  assert.equal(self.status, 400);
  assert.equal(self.data.error.code, 'self_operation');

  // 不能把别人提到与自己同级
  const escalate = await call('/api/admin/members/' + m.id + '/role', {
    method: 'PATCH', body: { role: 'admin' }, token: T.admin
  });
  assert.equal(escalate.status, 403);

  // 运营没有 member:manage
  const opTry = await call('/api/admin/members/' + m.id + '/role', {
    method: 'PATCH', body: { role: 'admin' }, token: T.operator
  });
  assert.equal(opTry.status, 403);
});

test('禁用账号立即踢下线，禁用后无法登录', async () => {
  const m = await newMember('禁用测试');
  const disable = await call('/api/admin/members/' + m.id + '/status', {
    method: 'PATCH', body: { status: 'disabled', remark: '测试禁用' }, token: T.admin
  });
  assert.equal(disable.status, 200);
  assert.ok(disable.data.revokedSessions >= 1, '禁用应踢掉在线会话');

  const dead = await call('/api/me', { token: m.token });
  assert.equal(dead.status, 401);

  const blocked = await login(m.phone, 'abc12345', false);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'account_disabled');

  const enable = await call('/api/admin/members/' + m.id + '/status', {
    method: 'PATCH', body: { status: 'active' }, token: T.admin
  });
  assert.equal(enable.status, 200);
  assert.equal((await login(m.phone, 'abc12345', false)).status, 200);
});

test('成员列表带上在线设备数与锁定状态', async () => {
  const r = await call('/api/admin/members', { token: T.admin });
  assert.equal(r.status, 200);
  assert.ok(r.data.members.length >= 5);
  assert.ok(r.data.stats.backend >= 4);
  const admin = r.data.members.find(m => m.role === 'admin');
  assert.ok(admin, '应包含超管');
  assert.equal(typeof admin.activeSessions, 'number');
});

/* ---------------- 提现与打款 ---------------- */

test('提现只落 pending，打款后才 paid；失败会退款', async () => {
  const m = await newMember('打款测试');

  // 先给点可用余额：走真实账本
  const wallet = require('../server/wallet');
  wallet.creditPending(m.id, 6000, 'test', 'seed', '测试入账');
  wallet.releasePending(m.id, 6000, 'test', 'seed', '测试解冻');

  const realname = await call('/api/me/realname', {
    method: 'POST', body: { name: '测试用户', idNumber: '110101199001011234' }, token: m.token
  });
  assert.equal(realname.status, 200);

  const w1 = await call('/api/withdrawals', { method: 'POST', body: { amount: 3000, channel: 'wechat' }, token: m.token });
  assert.equal(w1.status, 200);
  assert.equal(w1.data.status, 'pending', '提现应先落 pending，不能直接标已支付');
  assert.equal(w1.data.wallet.available, 3000, '余额应已扣减');

  const list = await call('/api/admin/withdrawals?status=pending', { token: T.finance });
  assert.equal(list.status, 200);
  const mine = list.data.withdrawals.find(w => w.id === w1.data.id);
  assert.ok(mine, '财务应能看到待打款单');

  // 审核员没有打款权
  const deny = await call('/api/admin/withdrawals/' + w1.data.id + '/pay', {
    method: 'PATCH', body: { action: 'pay' }, token: T.reviewer
  });
  assert.equal(deny.status, 403);

  const pay = await call('/api/admin/withdrawals/' + w1.data.id + '/pay', {
    method: 'PATCH', body: { action: 'pay' }, token: T.finance
  });
  assert.equal(pay.status, 200);
  assert.equal(pay.data.status, 'paid');

  const again = await call('/api/admin/withdrawals/' + w1.data.id + '/pay', {
    method: 'PATCH', body: { action: 'pay' }, token: T.finance
  });
  assert.equal(again.status, 409, '重复打款应被拒');

  // 再提一笔，标记失败应退款
  const w2 = await call('/api/withdrawals', { method: 'POST', body: { amount: 2000, channel: 'alipay' }, token: m.token });
  assert.equal(w2.status, 200);
  const afterWithdraw = w2.data.wallet.available;

  const fail = await call('/api/admin/withdrawals/' + w2.data.id + '/pay', {
    method: 'PATCH', body: { action: 'fail', note: '渠道退回' }, token: T.finance
  });
  assert.equal(fail.status, 200);
  assert.equal(fail.data.refunded, 2000);

  const walletAfter = await call('/api/wallet', { token: m.token });
  assert.equal(walletAfter.data.available, afterWithdraw + 2000, '失败应退回可用余额');

  // 审计要能查到这两笔
  const payLog = db.prepare("SELECT * FROM audit_logs WHERE action = 'withdrawal.pay' AND target = ?")
    .get('withdrawal:' + w1.data.id);
  assert.ok(payLog, '打款必须留痕');
  assert.equal(payLog.actor_role, 'finance');

  const failLog = db.prepare("SELECT * FROM audit_logs WHERE action = 'withdrawal.fail' AND target = ?")
    .get('withdrawal:' + w2.data.id);
  assert.ok(failLog, '打款失败也必须留痕');
});

/* ---------------- 审计 ---------------- */

test('审计可按动作与结果筛选，且不能通过接口修改', async () => {
  const denied = await call('/api/admin/audit-logs?result=denied&limit=5', { token: T.admin });
  assert.equal(denied.status, 200);
  assert.ok(denied.data.logs.every(l => l.result === 'denied'));
  assert.ok(denied.data.summary.denied24h >= 1);

  const byAction = await call('/api/admin/audit-logs?action=withdrawal', { token: T.admin });
  assert.equal(byAction.status, 200);
  assert.ok(byAction.data.logs.every(l => l.action.startsWith('withdrawal')));

  // 审计没有写接口
  const write = await call('/api/admin/audit-logs', { method: 'POST', body: { action: 'fake' }, token: T.admin });
  assert.equal(write.status, 404, '审计表不提供写入接口');
});

test('登录与退出都留痕', async () => {
  const m = await login('finance', 'fn123456');
  const row = db.prepare("SELECT * FROM audit_logs WHERE action = 'auth.login' AND actor_name = '陈财务' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, '登录应留痕');
  assert.equal(row.actor_role, 'finance');

  const out = await call('/api/auth/logout', { method: 'POST', token: m.data.token });
  assert.equal(out.status, 200);

  const dead = await call('/api/me', { token: m.data.token });
  assert.equal(dead.status, 401, '退出后令牌应失效');

  const logoutLog = db.prepare("SELECT * FROM audit_logs WHERE action = 'auth.logout' ORDER BY id DESC LIMIT 1").get();
  assert.ok(logoutLog, '退出应留痕');
});
