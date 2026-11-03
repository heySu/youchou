'use strict';
/**
 * 数据库连接与建表。
 * 使用 Node 内置 node:sqlite（Node >= 22.5，需 --experimental-sqlite）。
 * 金额统一以「分」为整数存储，禁止浮点。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'youchou.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  phone          TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  password_hash  TEXT    NOT NULL,
  salt           TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'user',   -- user | admin
  credit_score   INTEGER NOT NULL DEFAULT 100,
  invite_code    TEXT    NOT NULL UNIQUE,
  invited_by     INTEGER,
  device_id      TEXT,
  real_name      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id),
  available_cents INTEGER NOT NULL DEFAULT 0,   -- 可提现
  pending_cents   INTEGER NOT NULL DEFAULT 0,   -- 冻结中（待结算/复核）
  total_cents     INTEGER NOT NULL DEFAULT 0    -- 累计收益
);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  kind          TEXT    NOT NULL,   -- pending_in | available_in | withdraw_out | reject_out | adjust
  amount_cents  INTEGER NOT NULL,   -- 正为入账，负为出账
  memo          TEXT,
  ref_type      TEXT,               -- commission | withdrawal
  ref_id        TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_user ON wallet_txns(user_id, id DESC);

CREATE TABLE IF NOT EXISTS sources (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  glyph       TEXT NOT NULL,
  color       TEXT NOT NULL,
  mode        TEXT NOT NULL,          -- offerwall | api | postback | hybrid
  pay_cents   INTEGER NOT NULL,       -- 题源结算价（平均，分）
  status      TEXT NOT NULL DEFAULT 'active',  -- active | limited | paused
  secret      TEXT NOT NULL,          -- Postback 签名密钥
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offers (
  id             TEXT PRIMARY KEY,
  source_key     TEXT NOT NULL REFERENCES sources(key),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  minutes        INTEGER NOT NULL,
  questions_json TEXT NOT NULL,
  reward_cents   INTEGER NOT NULL,   -- 给用户的佣金
  pay_cents      INTEGER NOT NULL,   -- 题源结算给我方的金额
  total_quota    INTEGER NOT NULL,
  left_quota     INTEGER NOT NULL,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  category       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',  -- open | closed
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offer_source ON offers(source_key);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  offer_id    TEXT    NOT NULL REFERENCES offers(id),
  device_id   TEXT,
  ip          TEXT,
  started_at  TEXT    NOT NULL,
  submitted_at TEXT,
  duration_ms INTEGER,
  status      TEXT    NOT NULL DEFAULT 'open'  -- open | submitted | abandoned
);
CREATE INDEX IF NOT EXISTS idx_session_user ON sessions(user_id, offer_id);

CREATE TABLE IF NOT EXISTS responses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  answers_json  TEXT NOT NULL,
  flags_json    TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commissions (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  offer_id       TEXT NOT NULL REFERENCES offers(id),
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  transaction_id TEXT NOT NULL UNIQUE,        -- 题源侧唯一单号（幂等键）
  reward_cents   INTEGER NOT NULL,
  pay_cents      INTEGER NOT NULL,
  status         TEXT NOT NULL,               -- pending | reviewing | approved | available | rejected | reversed
  flags_json     TEXT NOT NULL DEFAULT '[]',
  review_note    TEXT,
  reviewer       TEXT,
  created_at     TEXT NOT NULL,
  approved_at    TEXT,
  available_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_comm_user ON commissions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_comm_status ON commissions(status, approved_at);

CREATE TABLE IF NOT EXISTS postback_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key     TEXT NOT NULL,
  transaction_id TEXT,
  payload_json   TEXT NOT NULL,
  sign_valid     INTEGER NOT NULL,
  result         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  channel      TEXT NOT NULL,          -- wechat | alipay
  status       TEXT NOT NULL,          -- pending | paid | failed
  fail_reason  TEXT,
  created_at   TEXT NOT NULL,
  paid_at      TEXT
);

CREATE TABLE IF NOT EXISTS risk_rules (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  hits        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS risk_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  session_id TEXT,
  rule_key   TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_created ON risk_events(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 抓取日志：每次爬取留一条，用于对账与排障
CREATE TABLE IF NOT EXISTS crawl_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key   TEXT    NOT NULL,
  adapter      TEXT    NOT NULL,
  status       TEXT    NOT NULL,              -- ok | partial | failed | blocked
  pages        INTEGER NOT NULL DEFAULT 0,
  found        INTEGER NOT NULL DEFAULT 0,    -- 解析出的条目数
  inserted     INTEGER NOT NULL DEFAULT 0,    -- 新入库
  updated      INTEGER NOT NULL DEFAULT 0,    -- 已存在，更新元数据
  skipped      INTEGER NOT NULL DEFAULT 0,    -- 被过滤（标题太短/重复/robots 拒绝）
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  detail_json  TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crawl_source ON crawl_logs(source_key, id DESC);

-- 登录会话：令牌带 sid，服务端一票否决。
-- 没有这张表，令牌签发后就无法作废——改密码、禁用账号、踢设备全都做不到。
CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT    PRIMARY KEY,           -- sid，写进令牌
  user_id       INTEGER NOT NULL,
  ip            TEXT,
  ua            TEXT,
  device        TEXT,                          -- 人可读的设备标签
  created_at    TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  revoked_at    TEXT,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sess_user ON auth_sessions(user_id, id DESC);

-- 登录尝试流水：用于失败锁定与异常登录排查
CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account    TEXT    NOT NULL,
  ip         TEXT,
  ok         INTEGER NOT NULL,                 -- 1 成功 / 0 失败
  reason     TEXT,                             -- bad_credentials | locked | disabled
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_acc ON login_attempts(account, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_ip  ON login_attempts(ip, created_at DESC);

-- 操作审计：谁、什么时候、从哪个 IP、改了什么
-- 只增不改。越权尝试也要落库，这是事后追责的唯一依据。
CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id      INTEGER,
  actor_name    TEXT,
  actor_role    TEXT,
  action        TEXT    NOT NULL,              -- role.change / commission.review / auth.denied …
  target        TEXT,                          -- 被操作的资源标识
  detail_json   TEXT    NOT NULL DEFAULT '{}',
  ip            TEXT,
  ua            TEXT,
  result        TEXT    NOT NULL DEFAULT 'ok', -- ok | denied | failed
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
`;

db.exec(SCHEMA);

/**
 * 幂等迁移。
 * SQLite 的 ALTER TABLE 不支持 IF NOT EXISTS，所以先用 PRAGMA 查列再补，
 * 这样老库升级和新库建表走同一条路径，重复执行无副作用。
 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

function migrate() {
  // 题源：能否爬、怎么爬、最近一次抓取时间
  ensureColumn('sources', 'crawl_type', "crawl_type TEXT NOT NULL DEFAULT 'manual'"); // manual | adapter
  ensureColumn('sources', 'crawl_config', 'crawl_config TEXT');                      // 适配器参数 JSON
  ensureColumn('sources', 'last_crawled_at', 'last_crawled_at TEXT');
  ensureColumn('sources', 'default_pay_cents', 'default_pay_cents INTEGER NOT NULL DEFAULT 0');
  ensureColumn('sources', 'homepage', 'homepage TEXT');

  // 问卷：来源是可爬取的第三方任务，还是站内自带题库
  ensureColumn('offers', 'origin', "origin TEXT NOT NULL DEFAULT 'seed'");       // seed | crawled
  ensureColumn('offers', 'external_id', 'external_id TEXT');                     // 题源侧唯一 ID（去重键）
  ensureColumn('offers', 'external_url', 'external_url TEXT');                   // 原站任务地址
  ensureColumn('offers', 'delivery', "delivery TEXT NOT NULL DEFAULT 'inline'"); // inline | external
  ensureColumn('offers', 'fetched_at', 'fetched_at TEXT');
  ensureColumn('offers', 'review_note', 'review_note TEXT');

  // 同一题源下外部 ID 唯一，爬虫重复抓取不会产生重复任务
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_offer_external
             ON offers(source_key, external_id)
             WHERE external_id IS NOT NULL`);

  // 账号状态与安全字段
  ensureColumn('users', 'status', "status TEXT NOT NULL DEFAULT 'active'"); // active | disabled
  ensureColumn('users', 'last_login_at', 'last_login_at TEXT');
  ensureColumn('users', 'password_updated_at', 'password_updated_at TEXT');
  ensureColumn('users', 'locked_until', 'locked_until TEXT');              // 失败锁定到期时间
  ensureColumn('users', 'failed_count', 'failed_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'remark', 'remark TEXT');                          // 运营备注
}

migrate();

/** 事务包装：抛错自动回滚；支持嵌套（内层复用外层事务） */
let TX_DEPTH = 0;
function tx(fn) {
  if (TX_DEPTH > 0) {
    TX_DEPTH++;
    try { return fn(); } finally { TX_DEPTH--; }
  }
  db.exec('BEGIN IMMEDIATE');
  TX_DEPTH = 1;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    TX_DEPTH = 0;
  }
}

const now = () => new Date().toISOString();

module.exports = { db, tx, now, DB_PATH };
