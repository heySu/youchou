'use strict';
/**
 * 抓取结果入库。
 *
 * 两条原则：
 * 1. 去重靠 (source_key, external_id) 唯一索引 + 先查后写，重复抓取只更新元数据。
 * 2. 运营改过的字段（佣金、状态、配额）永远不被爬虫覆盖 —— 爬虫只负责
 *    「把新任务搬进来、把旧任务的标题链接刷新一下」。
 */

const { db, tx, now } = require('../db');

/** 外部任务默认给 100 个名额，避免和「限量抢单」的站内问卷混在一起 */
const DEFAULT_QUOTA = 100;

function findByExternalId(sourceKey, externalId) {
  return db.prepare('SELECT * FROM offers WHERE source_key = ? AND external_id = ?')
    .get(sourceKey, externalId);
}

function existingExternalIds(sourceKey) {
  const rows = db.prepare('SELECT external_id FROM offers WHERE source_key = ? AND external_id IS NOT NULL')
    .all(sourceKey);
  return new Set(rows.map(r => String(r.external_id)));
}

function insertOffer(item, { sourceName, defaultPayCents }) {
  // 页面拿不到佣金时用题源默认单价兜底，运营审核时可以逐条改
  const pay = item.payCents || defaultPayCents || 0;

  db.prepare(`INSERT INTO offers(
      id, source_key, title, description, minutes, questions_json,
      reward_cents, pay_cents, total_quota, left_quota, tags_json,
      category, status, created_at,
      origin, external_id, external_url, delivery, fetched_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    item.id,
    item.sourceKey,
    item.title,
    item.description || `来自题源「${sourceName}」的公开问卷，前往原站完成。`,
    item.minutes || 0,                 // 0 表示未知，前端显示「时长未知」
    '[]',                              // 外部任务不带题库，题目在原站
    pay,                               // 用户佣金：先按题源均价，运营可改
    pay,                               // 题源结算价：同上，作为参考
    DEFAULT_QUOTA,
    DEFAULT_QUOTA,
    JSON.stringify(item.tags || []),
    item.category || '社会',
    'pending_review',                  // 爬来的先审后上，不直接进大厅
    now(),
    'crawled',
    item.externalId,
    item.externalUrl,
    'external',
    item.fetchedAt || now()
  );
}

/** 只刷新「题源侧可能变、运营侧不该管」的字段 */
function refreshOffer(existing, item) {
  db.prepare(`UPDATE offers
      SET title = ?, description = ?, external_url = ?, category = ?,
          tags_json = ?, fetched_at = ?
      WHERE id = ?`).run(
    item.title,
    existing.description && existing.description.includes('运营补充') ? existing.description : item.description,
    item.externalUrl,
    existing.origin === 'crawled' ? (item.category || existing.category) : existing.category,
    JSON.stringify(item.tags || []),
    item.fetchedAt || now(),
    existing.id
  );
}

/**
 * 写入一批归一化后的条目。
 * @returns {{inserted:number, updated:number, skipped:number, skipReasons:object}}
 */
function persistItems(items, { sourceKey, sourceName, defaultPayCents = 0 }) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const skipReasons = {};

  tx(() => {
    for (const item of items) {
      if (item.skip) {
        skipped++;
        skipReasons[item.skip] = (skipReasons[item.skip] || 0) + 1;
        continue;
      }

      const existing = findByExternalId(sourceKey, item.externalId);
      if (existing) {
        refreshOffer(existing, item);
        updated++;
      } else {
        insertOffer(item, { sourceName, defaultPayCents });
        inserted++;
      }
    }
  });

  return { inserted, updated, skipped, skipReasons };
}

function writeLog(entry) {
  const {
    sourceKey, adapter, status, pages = 0,
    found = 0, inserted = 0, updated = 0, skipped = 0,
    durationMs = 0, error = null, detail = {}
  } = entry;

  const info = db.prepare(`INSERT INTO crawl_logs(
      source_key, adapter, status, pages, found, inserted, updated, skipped,
      duration_ms, error, detail_json, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    sourceKey, adapter, status, pages, found, inserted, updated, skipped,
    durationMs, error, JSON.stringify(detail), now()
  );

  db.prepare('UPDATE sources SET last_crawled_at = ? WHERE key = ?').run(now(), sourceKey);
  return Number(info.lastInsertRowid);
}

function listLogs({ sourceKey, limit = 30 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  if (sourceKey) {
    return db.prepare('SELECT * FROM crawl_logs WHERE source_key = ? ORDER BY id DESC LIMIT ?').all(sourceKey, n);
  }
  return db.prepare('SELECT * FROM crawl_logs ORDER BY id DESC LIMIT ?').all(n);
}

/** 待审的爬取任务 */
function listPending({ limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare(`SELECT o.*, s.name AS source_name, s.glyph AS source_glyph, s.color AS source_color
      FROM offers o JOIN sources s ON s.key = o.source_key
      WHERE o.origin = 'crawled' AND o.status = 'pending_review'
      ORDER BY o.fetched_at DESC, o.created_at DESC
      LIMIT ?`).all(n);
}

function crawlStats() {
  const row = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS online,
      SUM(CASE WHEN origin = 'crawled' THEN 1 ELSE 0 END) AS crawled
    FROM offers`).get();

  const sources = db.prepare(`SELECT key, name, crawl_type, last_crawled_at,
      (SELECT COUNT(*) FROM offers o WHERE o.source_key = sources.key AND o.origin = 'crawled') AS crawled_count
    FROM sources ORDER BY key`).all();

  return {
    total: row.total || 0,
    pending: row.pending || 0,
    online: row.online || 0,
    crawled: row.crawled || 0,
    sources
  };
}

module.exports = {
  persistItems, writeLog, listLogs, listPending, crawlStats,
  findByExternalId, existingExternalIds, DEFAULT_QUOTA
};
