'use strict';
/**
 * 抓取层：超时、重试、按站点限速、robots 校验。
 *
 * 爬虫最容易出的事不是解析错，而是把人家站点打挂或者被封 IP。
 * 所以这里默认就带三件东西：
 *   1. 同一站点串行 + 最小间隔（默认 1.2s，可被 robots 的 Crawl-delay 抬高）
 *   2. 429/5xx 退避重试，最多 2 次
 *   3. 每次请求前查 robots.txt
 */

const DEFAULT_UA =
  'YouChouBot/1.0 (+survey-aggregator; contact=ops@youchou.local)';
const DEFAULT_MIN_GAP_MS = 1200;
const DEFAULT_TIMEOUT_MS = 15000;

const lastHit = new Map(); // origin -> timestamp
const chains = new Map();  // origin -> Promise（保证同站串行）

function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return null; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 按响应头里的 charset 解码。国内不少站点还是 GBK/GB2312，
 * 一律按 UTF-8 解会得到满屏乱码，标题就全废了。
 */
function decodeBody(buffer, contentType) {
  const ct = String(contentType || '');
  const m = ct.match(/charset\s*=\s*["']?([\w-]+)/i);
  const charset = m ? m[1].toLowerCase() : 'utf-8';

  if (charset === 'utf-8' || charset === 'utf8') {
    return new TextDecoder('utf-8').decode(buffer);
  }
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (_) {
    // 运行环境没有这个编码表时退回 UTF-8，至少不会整页报废
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/** 同一 origin 的请求串行化，避免并发把对方打崩 */
function serialize(origin, task) {
  const prev = chains.get(origin) || Promise.resolve();
  const next = prev.then(task, task);
  chains.set(origin, next.then(() => {}, () => {}));
  return next;
}

async function throttle(origin, minGapMs) {
  const last = lastHit.get(origin) || 0;
  const wait = last + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(origin, Date.now());
}

/**
 * 发一个 GET，返回 { status, body, headers, url }。
 * 网络异常重试后仍失败则抛出，由调用方记进抓取日志。
 */
async function fetchText(url, opts = {}) {
  const {
    ua = DEFAULT_UA,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 2,
    minGapMs = DEFAULT_MIN_GAP_MS,
    headers = {}
  } = opts;

  const origin = originOf(url);
  if (!origin) throw new Error('非法 URL: ' + url);

  return serialize(origin, async () => {
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttle(origin, minGapMs);

      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
          headers: Object.assign(
            {
              'User-Agent': ua,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            },
            headers
          )
        });

        const buf = await res.arrayBuffer();
        const body = decodeBody(buf, res.headers.get('content-type'));

        // 429 与 5xx 值得再试一次，4xx 其余情况直接返回给上层判断
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10000)
            : 600 * Math.pow(2, attempt);
          await sleep(backoff);
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }

        return {
          status: res.status,
          body,
          url: res.url || url,
          headers: {
            contentType: res.headers.get('content-type') || '',
            etag: res.headers.get('etag') || ''
          }
        };
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(600 * Math.pow(2, attempt));
      }
    }

    throw lastErr || new Error('抓取失败');
  });
}

/**
 * 带 robots 校验的抓取。被 robots 拒绝时返回 blocked，不抛异常，
 * 让上层把它记为一条「被拒绝」的日志而不是失败。
 */
async function politeFetch(url, { robots, ua = DEFAULT_UA, ...rest } = {}) {
  const origin = originOf(url);
  const path = (() => {
    try {
      const u = new URL(url);
      return u.pathname + (u.search || '');
    } catch (_) { return '/'; }
  })();

  let rules = null;
  if (robots) {
    rules = await robots.getRules(origin, ua, (u, o) => fetchText(u, Object.assign({ ua }, o)));
    if (!robots.isAllowed(rules, path)) {
      return { blocked: true, reason: 'robots_disallow', status: 0, body: '', url };
    }
  }

  const minGapMs = rules && rules.crawlDelay
    ? Math.max(DEFAULT_MIN_GAP_MS, rules.crawlDelay)
    : (rest.minGapMs || DEFAULT_MIN_GAP_MS);

  const res = await fetchText(url, Object.assign({ ua, minGapMs }, rest));
  return Object.assign({ blocked: false }, res);
}

function resetThrottle() {
  lastHit.clear();
  chains.clear();
}

module.exports = { fetchText, politeFetch, DEFAULT_UA, resetThrottle };
