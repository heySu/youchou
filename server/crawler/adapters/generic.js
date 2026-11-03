'use strict';
/**
 * 配置式通用适配器。
 *
 * 现实里题源站点的列表页结构各不相同，但大多逃不出「分页 URL + 链接列表」
 * 这一个模式。与其为每个站点写一个文件，不如把规则外置成配置，运营在
 * 后台填一个 URL 模板和两条正则就能接入新源。
 *
 * 配置示例（存 sources.crawl_config）：
 * {
 *   "listUrl": "https://example.com/surveys?page={page}",
 *   "maxPages": 3,
 *   "linkPattern": "href=\"(https://example\\.com/s/(\\d+))\"[^>]*>([^<]{4,80})<",
 *   "urlGroup": 1,
 *   "idGroup": 2,
 *   "titleGroup": 3
 * }
 */

const parse = require('../parse');

const DEFAULT_CONFIG = {
  listUrl: '',
  maxPages: 1,
  startPage: 1,
  linkPattern: '',
  urlGroup: 1,
  idGroup: 2,
  titleGroup: 3,
  minGapMs: 1500
};

function buildPageUrl(cfg, page) {
  if (!cfg.listUrl) throw new Error('通用适配器缺少 listUrl 配置');
  if (!cfg.listUrl.includes('{page}')) return cfg.listUrl;
  return cfg.listUrl.replace(/\{page\}/g, String(page));
}

function extractItems(html, cfg) {
  const out = [];
  const seen = new Set();
  if (!cfg.linkPattern) return out;

  let re;
  try {
    re = new RegExp(cfg.linkPattern, 'gi');
  } catch (e) {
    throw new Error('linkPattern 不是合法正则：' + e.message);
  }

  let m;
  let guard = 0;
  while ((m = re.exec(String(html || ''))) !== null && guard++ < 500) {
    if (m[0].length === 0) { re.lastIndex++; continue; }

    const url = m[cfg.urlGroup];
    const idRaw = cfg.idGroup ? m[cfg.idGroup] : null;
    const title = parse.collapse(m[cfg.titleGroup] || '');

    if (!url || !title) continue;

    // 没有显式 id 分组时，用 URL 本身当去重键
    const externalId = idRaw || url.slice(0, 60);
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    out.push({ externalId, title, url });
  }

  return out;
}

async function crawl(ctx) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, ctx.config || {});
  if (!cfg.listUrl) {
    throw new Error('该题源未配置 listUrl，请在后台「题源抓取」里补充抓取规则');
  }

  const maxPages = Math.min(Math.max(Number(cfg.maxPages) || 1, 1), 10);
  const startPage = Math.max(Number(cfg.startPage) || 1, 1);

  const items = [];
  const seen = new Set();
  const pagesInfo = [];
  let pages = 0;

  for (let page = startPage; page < startPage + maxPages; page++) {
    const url = buildPageUrl(cfg, page);
    const res = await ctx.fetch(url, { minGapMs: cfg.minGapMs });

    if (res.blocked) {
      pagesInfo.push({ page, url, blocked: true, reason: res.reason });
      break;
    }
    if (res.status !== 200) {
      pagesInfo.push({ page, url, status: res.status });
      break;
    }

    pages++;
    const found = extractItems(res.body, cfg);
    pagesInfo.push({ page, url, count: found.length });
    if (found.length === 0) break;

    let fresh = 0;
    for (const it of found) {
      if (seen.has(it.externalId)) continue;
      seen.add(it.externalId);
      items.push(it);
      fresh++;
    }
    if (fresh === 0) break;
  }

  return { items, pages, detail: { pages: pagesInfo } };
}

module.exports = {
  key: 'generic',
  sourceKey: 'generic',
  name: '配置式抓取',
  reliability: 'configurable',
  note: '通过 URL 模板 + 正则配置接入任意列表型页面',
  DEFAULT_CONFIG,
  crawl,
  extractItems
};
