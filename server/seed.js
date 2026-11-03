'use strict';
/**
 * 种子数据。用法：npm run seed
 * 会清空业务表后重建，方便反复演示。
 */
const crypto = require('node:crypto');
const { db, tx, now, DB_PATH } = require('./db');
const { SOURCES, OFFERS, RISK_RULES } = require('./data/catalog');
const { makeSalt, hashPassword } = require('./auth');
const wallet = require('./wallet');

const RESET = process.argv.includes('--reset');
const uid = () => crypto.randomBytes(6).toString('hex');

function iso(daysAgo, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, Math.floor(Math.random() * 59), 0, 0);
  return d.toISOString();
}

function clear() {
  const tables = [
    'risk_events', 'postback_logs', 'withdrawals', 'commissions', 'responses',
    'sessions', 'wallet_txns', 'wallets', 'offers', 'sources', 'risk_rules',
    'audit_logs', 'login_attempts', 'auth_sessions', 'crawl_logs',
    'users', 'settings'
  ];
  db.exec('PRAGMA foreign_keys = OFF');
  tables.forEach(t => { try { db.exec(`DELETE FROM ${t}`); } catch (_) {} });
  db.exec("DELETE FROM sqlite_sequence");
  db.exec('PRAGMA foreign_keys = ON');
}

function createUser({ phone, name, password, role = 'user', deviceId, credit = 100 }) {
  const salt = makeSalt();
  const code = 'YC-' + uid().slice(0, 8).toUpperCase();
  const r = db.prepare(`INSERT INTO users
    (phone, name, password_hash, salt, role, status, credit_score, invite_code, device_id, real_name, created_at, password_updated_at)
    VALUES (?,?,?,?,?, 'active', ?,?,?,?,?,?)`)
    .run(phone, name, hashPassword(password, salt), salt, role, credit, code, deviceId || null, 1, now(), now());
  const id = Number(r.lastInsertRowid);
  wallet.ensureWallet(id);
  return id;
}

function seed({ reset = false, quiet = false, withHistory = true } = {}) {
  if (reset) clear();

  // 题源
  SOURCES.forEach(s => {
    db.prepare(`INSERT INTO sources(
        key, name, glyph, color, mode, pay_cents, status, secret, created_at,
        crawl_type, crawl_config, default_pay_cents, homepage
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        s.key, s.name, s.glyph, s.color, s.mode, s.pay_cents, s.status, s.secret, now(),
        s.crawl_type || 'manual',
        s.crawl_config ? JSON.stringify(s.crawl_config) : null,
        s.default_pay_cents || 0,
        s.homepage || null
      );
  });

  // 问卷
  OFFERS.forEach(o => {
    db.prepare(`INSERT INTO offers
      (id, source_key, title, description, minutes, questions_json, reward_cents, pay_cents,
       total_quota, left_quota, tags_json, category, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(o.id, o.source_key, o.title, o.description, o.minutes, JSON.stringify(o.questions),
           o.reward_cents, o.pay_cents, o.total_quota, o.left_quota,
           JSON.stringify(o.tags), o.category, 'open', now());
  });

  // 风控规则
  RISK_RULES.forEach(r => {
    db.prepare('INSERT INTO risk_rules(key, name, description, enabled, hits) VALUES(?,?,?,?,0)')
      .run(r.key, r.name, r.description, r.enabled);
  });

  // 账号
  const adminId = createUser({ phone: 'admin', name: '张运营', password: 'admin12345', role: 'admin' });
  const demoId = createUser({ phone: '13800000001', name: '王小明', password: 'demo123456', deviceId: 'dev_demo_0001' });

  // 三个后台角色各一个演示账号，用来验证职责分离确实生效
  createUser({ phone: 'operator', name: '李运营', password: 'op123456', role: 'operator' });
  createUser({ phone: 'reviewer', name: '赵审核', password: 'rv123456', role: 'reviewer' });
  createUser({ phone: 'finance', name: '陈财务', password: 'fn123456', role: 'finance' });

  // ---- 历史数据（走真实账本，保证账实相符）----
  const historyPlan = [
    { offer: 'sx-102', reward: 1250, daysAgo: 3, status: 'available' },
    { offer: 'sx-103', reward: 420,  daysAgo: 2, status: 'available' },
    { offer: 'sx-104', reward: 1500, daysAgo: 1, status: 'available' },
    { offer: 'sx-106', reward: 1800, daysAgo: 0, status: 'approved' } // 冻结中，冻结期结束后自动解冻
  ];

  if (withHistory) tx(() => {
    historyPlan.forEach((h, i) => {
      const id = 'cm_seed' + String(i).padStart(4, '0');
      const created = iso(h.daysAgo, 9 + i);
      const sessionId = 'ss_seed' + String(i).padStart(4, '0');
      db.prepare(`INSERT INTO sessions(id, user_id, offer_id, started_at, submitted_at, duration_ms, status)
        VALUES (?,?,?,?,?,?,'submitted')`)
        .run(sessionId, demoId, h.offer, created, created, 300000);
      db.prepare(`INSERT INTO commissions
        (id, user_id, offer_id, session_id, transaction_id, reward_cents, pay_cents, status, flags_json, created_at, approved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, demoId, h.offer, sessionId, 'seed_tx_' + i, h.reward, Math.round(h.reward / 0.74 / 10) * 10,
             'pending', '[]', created, created);

      wallet.creditPending(demoId, h.reward, 'commission', id, '问卷佣金（待结算）');

      if (h.status === 'available') {
        wallet.releasePending(demoId, h.reward, 'commission', id, '冻结期结束，佣金可提现');
        db.prepare("UPDATE commissions SET status='available', available_at=? WHERE id=?").run(created, id);
      } else {
        db.prepare("UPDATE commissions SET status='approved' WHERE id=?").run(id);
      }
    });

    // 新手礼金
    wallet.ensureWallet(demoId);
    db.prepare('UPDATE wallets SET available_cents = available_cents + 2000, total_cents = total_cents + 2000 WHERE user_id = ?')
      .run(demoId);
    db.prepare(`INSERT INTO wallet_txns(user_id, kind, amount_cents, memo, created_at)
      VALUES(?, 'adjust', 2000, '新手礼金', ?)`).run(demoId, iso(5, 12));

    // 一笔已到账提现
    const wid = 'wd_seed0001';
    db.prepare(`INSERT INTO withdrawals(id, user_id, amount_cents, channel, status, created_at, paid_at)
      VALUES(?,?,?,?,?,?,?)`).run(wid, demoId, 2000, 'wechat', 'paid', iso(4, 15), iso(4, 15));
    wallet.debitAvailable(demoId, 2000, 'withdrawal', wid, '提现至微信零钱');
  });

  const w = wallet.getWallet(demoId);
  if (quiet) return { adminId, demoId, wallet: w };
  console.log('— 种子数据写入完成 —');
  console.log('数据库:', DB_PATH);
  console.log('后台账号（密码按角色分权）:');
  console.log('  超管 admin    / admin12345  全部权限');
  console.log('  运营 operator / op123456    题源·抓取·上架');
  console.log('  审核 reviewer / rv123456    佣金复核·风控查看');
  console.log('  财务 finance  / fn123456    结算·提现打款');
  console.log('体验账号: 13800000001 / demo123456  可用 ¥%s  冻结 ¥%s  累计 ¥%s',
    (w.available / 100).toFixed(2), (w.pending / 100).toFixed(2), (w.total / 100).toFixed(2));
  console.log('题源 %d 家 · 问卷 %d 份 · 风控规则 %d 条', SOURCES.length, OFFERS.length, RISK_RULES.length);
  console.log('admin id=%d demo id=%d', adminId, demoId);
  return { adminId, demoId, wallet: w };
}

module.exports = { seed, clear };

if (require.main === module) {
  seed({ reset: true });
}
