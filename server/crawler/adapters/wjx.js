'use strict';
/**
 * 问卷星（wjx.cn）公开问卷适配器。
 *
 * 抓的是「最新公开问卷」列表页，这个页面不需要登录、robots 允许，
 * 每条是一个真实存在的问卷（标题 + 详情页地址）。平台把它作为
 * 「外部任务」收录：用户点进去在原站完成，回来由运营核销。
 *
 * 注意：这里只收录标题、链接、分类这些**公开元信息**，不抓取、
 * 不复制原站问卷的题目内容。题目版权属于问卷发布者。
 */

const parse = require('../parse');

const BOARD_PATHS = {
  newsurveys: '/newsurveys.aspx',   // 最新公开问卷
  recentupdate: '/recentupdate.aspx' // 最近更新
};

const DEFAULT_CONFIG = {
  board: 'newsurveys',
  maxPages: 3,
  minGapMs: 1500
};

function boardUrl(base, board, page) {
  const p = BOARD_PATHS[board] || BOARD_PATHS.newsurveys;
  const url = new URL(p, base);
  if (page > 1) url.searchParams.set('pagenumber', String(page));
  return url.toString();
}

/**
 * 从列表页 HTML 里抽出条目。
 * 结构形如：
 *   <div class="post_item"> ... <a href="https://www.wjx.cn/xz/392235259.aspx">标题</a> ... </div>
 */
function extractItems(html, { base = 'https://www.wjx.cn' } = {}) {
  const out = [];
  const seen = new Set();

  for (const a of parse.anchors(html)) {
    const href = a.href || '';
    if (!/^https?:\/\/(?:www\.)?wjx\.cn\//i.test(href) && !href.startsWith('/')) continue;

    const m = href.match(/\/(?:xz|vm|vj|jq)\/(\d{4,})\.aspx/i);
    if (!m) continue;

    const id = m[1];
    if (seen.has(id)) continue;

    const title = parse.collapse(a.text);
    if (!title || title.length < 4) continue;
    // 排除导航类文本
    if (/^(首页|登录|注册|更多|下一页|上一页|免费使用|帮助)/.test(title)) continue;

    seen.add(id);
    out.push({
      externalId: id,
      title,
      url: href.startsWith('/') ? base + href : href
    });
  }

  return out;
}

/**
 * 抓取入口。
 * ctx: { fetch, config, log }
 */
async function crawl(ctx) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, ctx.config || {});
  const base = 'https://www.wjx.cn';
  const maxPages = Math.min(Math.max(Number(cfg.maxPages) || 1, 1), 10);

  const items = [];
  const seen = new Set();
  const pagesInfo = [];
  let pages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = boardUrl(base, cfg.board, page);
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
    const found = extractItems(res.body, { base });
    pagesInfo.push({ page, url, count: found.length });

    if (found.length === 0) break; // 没有更多分页了

    let fresh = 0;
    for (const it of found) {
      if (seen.has(it.externalId)) continue;
      seen.add(it.externalId);
      items.push(Object.assign({ sourceName: '问卷星' }, it));
      fresh++;
    }

    // 整页都是见过的条目，说明已经翻到重复区，停
    if (fresh === 0) break;
  }

  return {
    items,
    pages,
    detail: { board: cfg.board, pages: pagesInfo }
  };
}

module.exports = {
  key: 'wjx',
  sourceKey: 'wjx',
  name: '问卷星',
  homepage: 'https://www.wjx.cn/newsurveys.aspx',
  reliability: 'stable',
  note: '公开问卷列表，无需登录；只收录标题与链接，不复制题目内容',
  DEFAULT_CONFIG,
  crawl,
  extractItems
};
