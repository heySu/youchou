'use strict';
/**
 * robots.txt 解析与判定。
 *
 * 抓取别人的站点就必须先问一句「这里能不能抓」。这里实现的是
 * RFC 9309 的常用子集：User-agent 分组、Allow/Disallow 前缀匹配、
 * Crawl-delay。匹配规则按「最长前缀优先，等长时 Allow 优先」。
 */

const CACHE_TTL_MS = 60 * 60 * 1000; // robots 缓存 1 小时
const cache = new Map(); // origin -> { at, rules }

function parseRobots(text, uaToken) {
  const lines = String(text || '').split(/\r?\n/);
  const groups = [];
  let current = null;
  let expectingAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !expectingAgent) {
        current = { agents: [], allow: [], disallow: [], crawlDelay: null };
        groups.push(current);
        expectingAgent = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    expectingAgent = false;

    if (field === 'allow') current.allow.push(value);
    else if (field === 'disallow') {
      // "Disallow:" 空值表示不限制任何路径
      if (value) current.disallow.push(value);
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n * 1000;
    }
  }

  const token = String(uaToken || '').toLowerCase();
  const specific = groups.find(g => g.agents.some(a => a !== '*' && token.includes(a)));
  const wildcard = groups.find(g => g.agents.includes('*'));
  const chosen = specific || wildcard || null;

  if (!chosen) return { allow: [], disallow: [], crawlDelay: null };
  return { allow: chosen.allow, disallow: chosen.disallow, crawlDelay: chosen.crawlDelay };
}

function matchLength(pattern, path) {
  // 支持 * 通配与 $ 结尾锚定（常见扩展，做了简化处理）
  let p = pattern;
  let endAnchor = false;
  if (p.endsWith('$')) { endAnchor = true; p = p.slice(0, -1); }

  if (!p.includes('*')) {
    if (endAnchor) return path === p ? p.length : -1;
    return path.startsWith(p) ? p.length : -1;
  }

  const parts = p.split('*').filter(Boolean);
  let cursor = 0;
  for (const part of parts) {
    const at = path.indexOf(part, cursor);
    if (at < 0) return -1;
    cursor = at + part.length;
  }
  if (endAnchor && cursor !== path.length) return -1;
  return p.length;
}

function isAllowed(rules, path) {
  const target = path || '/';
  let best = { len: -1, allow: true };

  for (const d of rules.disallow) {
    const len = matchLength(d, target);
    if (len > best.len) best = { len, allow: false };
  }
  for (const a of rules.allow) {
    const len = matchLength(a, target);
    // 等长时 Allow 优先（RFC 9309 3.2.2）
    if (len > best.len || (len === best.len && len >= 0)) best = { len, allow: true };
  }

  if (best.len < 0) return true;
  return best.allow;
}

/**
 * 取某站点的 robots 规则。取不到时按「允许」处理，但会打标记，
 * 调用方可以把这一点写进抓取日志，便于事后解释。
 */
async function getRules(origin, ua, fetchText) {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value = { allow: [], disallow: [], crawlDelay: null, reachable: false };
  try {
    const res = await fetchText(origin + '/robots.txt', { timeoutMs: 8000, retries: 1 });
    if (res.status === 200 && res.body) {
      value = Object.assign(parseRobots(res.body, ua), { reachable: true });
    } else if (res.status === 404) {
      // 没有 robots.txt 视为不限制
      value.reachable = true;
    }
  } catch (_) {
    // 网络异常时放行，但标记为不可达，日志里能看出来
  }

  cache.set(origin, { at: Date.now(), value });
  return value;
}

function resetCache() {
  cache.clear();
}

module.exports = { parseRobots, isAllowed, getRules, resetCache, CACHE_TTL_MS };
