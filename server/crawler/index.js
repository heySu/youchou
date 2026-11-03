'use strict';
/**
 * 爬虫调度入口。
 *
 * 一次抓取的完整生命周期：
 *   读题源配置 → 选适配器 → 带 robots 限速抓取 → 归一化 → 去重入库 → 写日志
 *
 * 所有异常都被收敛成一条 failed 日志，不会把进程打挂，
 * 也不会因为某个源挂了影响其他源的抓取。
 */

const { db, now } = require('../db');
const robots = require('./robots');
const http = require('./http');
const normalize = require('./normalize');
const store = require('./store');
const adapters = require('./adapters');

const UA = process.env.CRAWLER_UA || http.DEFAULT_UA;

function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function getSource(sourceKey) {
  return db.prepare('SELECT * FROM sources WHERE key = ?').get(sourceKey);
}

/** 找出这个题源该用哪个适配器：配置里显式指定优先，否则用 source.key */
function resolveAdapter(src, config) {
  const key = config.adapter || src.key;
  return adapters.get(key);
}

/**
 * 抓一个题源。
 * @returns {Promise<{ok:boolean, sourceKey:string, status:string, found:number,
 *   inserted:number, updated:number, skipped:number, pages:number, durationMs:number, error?:string}>}
 */
async function runCrawl(sourceKey, options = {}) {
  const startedAt = Date.now();
  const src = getSource(sourceKey);

  if (!src) {
    const err = new Error(`题源不存在: ${sourceKey}`);
    err.code = 'unknown_source';
    throw err;
  }

  const config = Object.assign({}, parseConfig(src.crawl_config), options.config || {});
  if (options.maxPages) config.maxPages = options.maxPages;

  const adapter = resolveAdapter(src, config);
  const adapterKey = adapter ? adapter.key : String(config.adapter || src.key);

  if (!adapter) {
    const reason = `该题源未接入适配器（crawl_type=${src.crawl_type}），请先配置抓取规则`;
    store.writeLog({
      sourceKey, adapter: adapterKey, status: 'failed',
      durationMs: Date.now() - startedAt, error: reason
    });
    return {
      ok: false, sourceKey, status: 'failed', error: reason,
      found: 0, inserted: 0, updated: 0, skipped: 0, pages: 0,
      durationMs: Date.now() - startedAt
    };
  }

  const fetchImpl = (url, opts = {}) =>
    http.politeFetch(url, Object.assign({ robots, ua: UA }, opts));

  try {
    const result = await adapter.crawl({
      fetch: fetchImpl,
      config,
      ua: UA,
      log: (...args) => {
        if (process.env.CRAWL_DEBUG) console.log('[crawl]', sourceKey, ...args);
      }
    });

    const knownIds = store.existingExternalIds(sourceKey);
    const normalized = (result.items || []).map(raw =>
      normalize.normalizeItem(raw, { sourceKey, now: now(), knownIds }));

    const written = store.persistItems(normalized, {
      sourceKey,
      sourceName: src.name,
      defaultPayCents: src.default_pay_cents || 0
    });

    const durationMs = Date.now() - startedAt;
    const status = written.inserted + written.updated > 0 ? 'ok' : 'partial';

    const logId = store.writeLog({
      sourceKey,
      adapter: adapterKey,
      status,
      pages: result.pages || 0,
      found: normalized.length,
      inserted: written.inserted,
      updated: written.updated,
      skipped: written.skipped,
      durationMs,
      detail: Object.assign({}, result.detail || {}, { skipReasons: written.skipReasons })
    });

    return {
      ok: true,
      sourceKey,
      adapter: adapterKey,
      status,
      logId,
      pages: result.pages || 0,
      found: normalized.length,
      inserted: written.inserted,
      updated: written.updated,
      skipped: written.skipped,
      skipReasons: written.skipReasons,
      durationMs,
      detail: result.detail || {}
    };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    store.writeLog({
      sourceKey,
      adapter: adapterKey,
      status: 'failed',
      durationMs,
      error: e.message,
      detail: { stack: String(e.stack || '').split('\n').slice(0, 5) }
    });

    return {
      ok: false,
      sourceKey,
      adapter: adapterKey,
      status: 'failed',
      error: e.message,
      found: 0, inserted: 0, updated: 0, skipped: 0, pages: 0,
      durationMs
    };
  }
}

/** 抓所有 crawl_type='adapter' 的题源，逐个串行执行，互不影响 */
async function runAll(options = {}) {
  const rows = db.prepare("SELECT key FROM sources WHERE crawl_type = 'adapter' ORDER BY key").all();
  const results = [];
  for (const r of rows) {
    results.push(await runCrawl(r.key, options));
  }
  return {
    total: results.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    inserted: results.reduce((s, r) => s + (r.inserted || 0), 0),
    updated: results.reduce((s, r) => s + (r.updated || 0), 0),
    results
  };
}

module.exports = {
  runCrawl,
  runAll,
  listAdapters: adapters.list,
  listLogs: store.listLogs,
  listPending: store.listPending,
  crawlStats: store.crawlStats,
  resetCache: () => { robots.resetCache(); http.resetThrottle(); }
};
