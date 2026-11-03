'use strict';
/**
 * 极简 HTML 解析工具。
 *
 * 不引入 cheerio/jsdom —— 项目约定零依赖，而且爬虫需要的只是
 * 「抓链接、取文本、按块切分」这三件事，正则足够，也更快。
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', times: '×'
};

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch (_) { return m; }
      }
      return m;
    }
    const v = ENTITIES[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '));
}

function collapse(s) {
  return String(s || '').replace(/[\s\u00a0\u3000]+/g, ' ').trim();
}

function textOf(html) {
  return collapse(stripTags(html));
}

/** 从一段标签文本里取属性值，兼容单双引号与无引号 */
function attr(tagHtml, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = String(tagHtml || '').match(re);
  if (!m) return null;
  return decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
}

/** 取出所有 <a ...>text</a> */
function anchors(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    out.push({
      href: attr(m[1], 'href'),
      text: textOf(m[2]),
      html: m[0],
      attrs: m[1]
    });
  }
  return out;
}

/**
 * 按起始标记把文档切成块。用于「每条任务一个 div」这类列表页：
 * 找到每个块的起点，再切到下一个起点之前。
 */
function splitBlocks(html, startRe) {
  const s = String(html || '');
  const re = typeof startRe === 'string' ? new RegExp(startRe, 'gi') : startRe;
  const starts = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    starts.push(m.index);
    if (m[0].length === 0) re.lastIndex++; // 防零宽匹配死循环
  }
  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : s.length;
    blocks.push(s.slice(starts[i], end));
  }
  return blocks;
}

/** 取 <title> */
function pageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? textOf(m[1]) : '';
}

/** 截断到指定长度，用于生成描述 */
function truncate(s, n) {
  const t = collapse(s);
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

module.exports = {
  decodeEntities, stripTags, collapse, textOf,
  attr, anchors, splitBlocks, pageTitle, truncate
};
