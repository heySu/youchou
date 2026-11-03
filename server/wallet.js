'use strict';
/**
 * 钱包账本。
 * 所有余额变动必须经过这里，保证 wallets 与 wallet_txns 永远对得上。
 *
 * 不变式：available + pending + withdrawn === total
 *   total    = 累计确认收益（提交即计入，驳回则扣回）
 *   pending  = 未结算冻结
 *   available= 可提现
 *   withdrawn= 已提现（total - available - pending）
 */
const { db, now } = require('./db');

function ensureWallet(userId) {
  const row = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  if (row) return row;
  db.prepare('INSERT INTO wallets(user_id, available_cents, pending_cents, total_cents) VALUES(?,0,0,0)').run(userId);
  return db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
}

function getWallet(userId) {
  const w = ensureWallet(userId);
  return {
    available: w.available_cents,
    pending: w.pending_cents,
    total: w.total_cents,
    withdrawn: w.total_cents - w.available_cents - w.pending_cents
  };
}

function txn(userId, kind, amount, memo, refType, refId) {
  db.prepare(
    'INSERT INTO wallet_txns(user_id, kind, amount_cents, memo, ref_type, ref_id, created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(userId, kind, amount, memo || null, refType || null, refId || null, now());
}

/** 提交答卷：佣金进入冻结 */
function creditPending(userId, cents, refType, refId, memo) {
  ensureWallet(userId);
  db.prepare('UPDATE wallets SET pending_cents = pending_cents + ?, total_cents = total_cents + ? WHERE user_id = ?')
    .run(cents, cents, userId);
  txn(userId, 'pending_in', cents, memo, refType, refId);
}

/** 结算解冻：冻结 -> 可用 */
function releasePending(userId, cents, refType, refId, memo) {
  ensureWallet(userId);
  db.prepare('UPDATE wallets SET pending_cents = pending_cents - ?, available_cents = available_cents + ? WHERE user_id = ?')
    .run(cents, cents, userId);
  txn(userId, 'available_in', cents, memo, refType, refId);
}

/** 审核驳回：扣回冻结与累计收益 */
function rejectPending(userId, cents, refType, refId, memo) {
  ensureWallet(userId);
  db.prepare('UPDATE wallets SET pending_cents = pending_cents - ?, total_cents = total_cents - ? WHERE user_id = ?')
    .run(cents, cents, userId);
  txn(userId, 'reject_out', -cents, memo, refType, refId);
}

/** 提现：扣减可用余额 */
function debitAvailable(userId, cents, refType, refId, memo) {
  ensureWallet(userId);
  db.prepare('UPDATE wallets SET available_cents = available_cents - ? WHERE user_id = ?').run(cents, userId);
  txn(userId, 'withdraw_out', -cents, memo, refType, refId);
}

/** 冲正（题源事后撤回已结算佣金） */
function reverseAvailable(userId, cents, refType, refId, memo) {
  ensureWallet(userId);
  db.prepare('UPDATE wallets SET available_cents = available_cents - ?, total_cents = total_cents - ? WHERE user_id = ?')
    .run(cents, cents, userId);
  txn(userId, 'reject_out', -cents, memo, refType, refId);
}

module.exports = { ensureWallet, getWallet, creditPending, releasePending, rejectPending, debitAvailable, reverseAvailable };
