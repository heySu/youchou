'use strict';
/**
 * 爬虫子系统的单元与集成测试。
 *
 * 这些用例**不联网**：解析用 fixtures 里保存的真实页面片段，
 * 入库用临时数据库。这样 CI 里可以稳定重复跑，不会因为对方站点
 * 改版或网络抖动而红。
 *
 * 联网的真实抓取另行用 `npm run crawl` 手动验证。
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), 'youchou-crawl-test-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const robots = require('../server/crawler/robots');
const normalize = require('../server/crawler/normalize');
const wjx = require('../server/crawler/adapters/wjx');
const generic = require('../server/crawler/adapters/generic');
const store = require('../server/crawler/store');
const { db } = require('../server/db');
const { seed } = require('../server/seed');

const FIXTURE = path.join(__dirname, 'fixtures', 'wjx-list.html');

before(() => {
  seed({ reset: true, quiet: true, withHistory: false });
});

after(() => {
  try { db.close(); } catch (_) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

/* ---------------- 启动行为 ---------------- */

test('系统启动不自动抓取：初始化后无抓取日志、无爬取来源任务', () => {
  const logs = db.prepare('SELECT COUNT(*) AS c FROM crawl_logs').get().c;
  assert.equal(logs, 0, '初始化不应产生任何抓取日志，抓取只能由「抓取最新题源」按钮或 npm run crawl 触发');
  const crawled = db.prepare("SELECT COUNT(*) AS c FROM offers WHERE origin = 'crawled'").get().c;
  assert.equal(crawled, 0, '初始化不应产生爬取来源的问卷任务');
});

/* ---------------- robots.txt ---------------- */

test('robots：前缀匹配与最长优先', () => {
  const rules = robots.parseRobots(`
# 注释行
User-agent: *
Disallow: /private/
Allow: /private/public/
Crawl-delay: 2
`, 'YouChouBot/1.0');

  assert.equal(robots.isAllowed(rules, '/'), true, '根路径未被禁止');
  assert.equal(robots.isAllowed(rules, '/surveys?page=1'), true);
  assert.equal(robots.isAllowed(rules, '/private/list'), false, '命中 Disallow');
  assert.equal(robots.isAllowed(rules, '/private/public/x'), true, 'Allow 更长，优先于 Disallow');
  assert.equal(rules.crawlDelay, 2000, 'Crawl-delay 换算为毫秒');
});

test('robots：指定 UA 的分组优先于通配分组', () => {
  const rules = robots.parseRobots(`
User-agent: *
Disallow: /

User-agent: YouChouBot
Allow: /surveys
Disallow: /surveys/private
`, 'YouChouBot/1.0 (+contact)');

  assert.equal(robots.isAllowed(rules, '/surveys'), true, '走自己的分组，不受通配 Disallow: / 影响');
  assert.equal(robots.isAllowed(rules, '/surveys/private/x'), false);
  assert.equal(robots.isAllowed(rules, '/other'), true);
});

test('robots：无匹配分组时默认放行', () => {
  const rules = robots.parseRobots('User-agent: Googlebot\nDisallow: /', 'YouChouBot/1.0');
  assert.equal(robots.isAllowed(rules, '/anything'), true);
});

/* ---------------- 题目解析 ---------------- */

test('wjx 适配器：从真实列表页片段解析出任务', () => {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  const items = wjx.extractItems(html);

  assert.ok(items.length >= 3, '至少解析出 3 条，实际 ' + items.length);

  for (const it of items) {
    assert.match(it.externalId, /^\d{4,}$/, 'externalId 必须是数字 ID');
    assert.match(it.url, /^https:\/\/www\.wjx\.cn\/(xz|vm|vj|jq)\/\d+\.aspx$/, 'URL 必须指向详情页');
    assert.ok(it.title.length >= 4, '标题不能过短：' + it.title);
    assert.ok(!/^(首页|登录|注册|更多|下一页)$/.test(it.title), '不能把导航文本当成任务');
  }
});

test('wjx 适配器：同一页重复内容不会产生重复条目', () => {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  const once = wjx.extractItems(html);
  const twice = wjx.extractItems(html + html);
  assert.equal(twice.length, once.length, '页内按 externalId 去重');
});

/* ---------------- 归一化 ---------------- */

test('归一化：标题清洗去掉营销尾巴', () => {
  assert.equal(normalize.cleanTitle('  某某消费调查问卷【已结束】 '), '某某消费调查问卷');
  assert.equal(normalize.cleanTitle('职场调研 - 问卷星'), '职场调研');
  assert.equal(normalize.cleanTitle('正常标题'), '正常标题');
});

test('归一化：脏数据被拦下', () => {
  assert.equal(normalize.rejectReason(''), 'empty_title');
  assert.equal(normalize.rejectReason('好'), 'title_too_short');
  assert.equal(normalize.rejectReason('....'), 'no_letters');
  assert.equal(normalize.rejectReason('大学生家长调查问卷'), null);
});

test('归一化：分类按关键词推断', () => {
  assert.equal(normalize.guessCategory('大学生家长调查问卷'), '教育');
  assert.equal(normalize.guessCategory('短视频使用习惯调研'), '娱乐');
  assert.equal(normalize.guessCategory('职场通勤与加班情况'), '职场');
  assert.equal(normalize.guessCategory('完全无关的标题'), '社会');
});

test('归一化：拿不到的字段留空，不编造', () => {
  const r = normalize.normalizeItem(
    { externalId: '123456', title: '家长问卷调查', url: 'https://www.wjx.cn/xz/123456.aspx' },
    { sourceKey: 'wjx', now: '2026-01-01T00:00:00.000Z' }
  );

  assert.equal(r.skip, null);
  assert.equal(r.id, 'cr_wjx_123456', '主键可回溯到题源与外部 ID');
  assert.equal(r.minutes, null, '页面没给时长就留 null');
  assert.equal(r.payCents, null, '页面没给佣金就留 null');
  assert.equal(r.externalUrl, 'https://www.wjx.cn/xz/123456.aspx');
  assert.ok(r.tags.includes('新抓取'));
});

test('归一化：缺 ID 或非法 URL 直接跳过', () => {
  const ctx = { sourceKey: 'wjx', now: '2026-01-01T00:00:00.000Z' };
  assert.equal(normalize.normalizeItem({ title: '家长调查问卷', url: 'https://a.com/1' }, ctx).skip, 'missing_external_id');
  assert.equal(normalize.normalizeItem({ externalId: '1', title: '家长调查问卷', url: 'ftp://a.com' }, ctx).skip, 'bad_url');
});

/* ---------------- 通用适配器 ---------------- */

test('通用适配器：按配置正则解析列表', () => {
  const cfg = {
    linkPattern: 'href="(https://example\\.com/s/(\\d+))"[^>]*>([^<]{4,80})<',
    urlGroup: 1, idGroup: 2, titleGroup: 3
  };
  const html = '<ul><li><a href="https://example.com/s/9001">一个测试问卷标题</a></li>' +
               '<li><a href="https://example.com/s/9002">另一个测试问卷</a></li></ul>';

  const items = generic.extractItems(html, cfg);
  assert.equal(items.length, 2);
  assert.equal(items[0].externalId, '9001');
  assert.equal(items[0].url, 'https://example.com/s/9001');
  assert.equal(items[0].title, '一个测试问卷标题');
});

test('通用适配器：没有 listUrl 时给出明确报错', async () => {
  await assert.rejects(
    () => generic.crawl({ fetch: async () => ({ status: 200, body: '' }), config: {} }),
    /未配置 listUrl/
  );
});

/* ---------------- 入库与去重 ---------------- */

function makeItem(externalId, title) {
  return normalize.normalizeItem(
    { externalId, title, url: 'https://www.wjx.cn/xz/' + externalId + '.aspx' },
    { sourceKey: 'wjx', now: new Date().toISOString() }
  );
}

test('入库：首次插入，重复抓取只更新不重复插入', () => {
  const items = [makeItem('500001', '第一个测试问卷'), makeItem('500002', '第二个测试问卷')];

  const first = store.persistItems(items, { sourceKey: 'wjx', sourceName: '问卷星', defaultPayCents: 900 });
  assert.equal(first.inserted, 2, '第一次全部新增');
  assert.equal(first.updated, 0);

  const second = store.persistItems(items, { sourceKey: 'wjx', sourceName: '问卷星', defaultPayCents: 900 });
  assert.equal(second.inserted, 0, '第二次不应重复插入');
  assert.equal(second.updated, 2, '只更新元数据');

  const count = db.prepare("SELECT COUNT(*) c FROM offers WHERE external_id IN ('500001','500002')").get().c;
  assert.equal(count, 2, '库里仍然只有两条');
});

test('入库：爬来的任务默认待审、走外部交付、带题源默认价', () => {
  const row = store.findByExternalId('wjx', '500001');
  assert.equal(row.status, 'pending_review', '先审后上，不直接进大厅');
  assert.equal(row.origin, 'crawled');
  assert.equal(row.delivery, 'external');
  assert.equal(row.questions_json, '[]', '外部任务不携带题库');
  assert.equal(row.reward_cents, 900, '无页面佣金时用题源默认价兜底');
  assert.equal(row.source_key, 'wjx');
});

test('入库：运营改过的价格与状态不会被下一次抓取覆盖', () => {
  const before = store.findByExternalId('wjx', '500001');
  db.prepare("UPDATE offers SET reward_cents = 500, status = 'open', pay_cents = 1200 WHERE id = ?").run(before.id);

  const again = store.persistItems(
    [makeItem('500001', '改过标题的第一个问卷')],
    { sourceKey: 'wjx', sourceName: '问卷星', defaultPayCents: 900 }
  );
  assert.equal(again.updated, 1);

  const afterRow = store.findByExternalId('wjx', '500001');
  assert.equal(afterRow.reward_cents, 500, '佣金是运营定的，爬虫不能改');
  assert.equal(afterRow.pay_cents, 1200, '结算价同理');
  assert.equal(afterRow.status, 'open', '已上架状态不能被打回待审');
  assert.equal(afterRow.title, '改过标题的第一个问卷', '标题跟着题源刷新');
});

test('入库：脏条目计入 skipped 并给出原因', () => {
  const items = [
    makeItem('500003', '合法的第三个问卷'),
    { skip: 'title_too_short' }
  ];
  const r = store.persistItems(items, { sourceKey: 'wjx', sourceName: '问卷星', defaultPayCents: 900 });
  assert.equal(r.inserted, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.skipReasons.title_too_short, 1);
});

/* ---------------- 日志与统计 ---------------- */

test('抓取日志：写入后可读回，并刷新题源最近抓取时间', () => {
  const id = store.writeLog({
    sourceKey: 'wjx', adapter: 'wjx', status: 'ok',
    pages: 2, found: 10, inserted: 8, updated: 2, skipped: 0,
    durationMs: 3200, detail: { board: 'newsurveys' }
  });
  assert.ok(id > 0);

  const logs = store.listLogs({ sourceKey: 'wjx', limit: 5 });
  assert.equal(logs.length >= 1, true);
  assert.equal(logs[0].status, 'ok');
  assert.equal(logs[0].found, 10);

  const src = db.prepare("SELECT last_crawled_at FROM sources WHERE key = 'wjx'").get();
  assert.ok(src.last_crawled_at, '抓取后应更新 last_crawled_at');
});

test('统计：能区分待审 / 已上架 / 爬取来源', () => {
  const s = store.crawlStats();
  assert.ok(s.crawled >= 3, '至少有三条爬取任务');
  assert.ok(s.pending >= 2, '有一条已上架，其余待审');
  assert.ok(s.sources.some(x => x.key === 'wjx' && x.crawl_type === 'adapter'));
  assert.ok(s.sources.some(x => x.crawl_type === 'manual'), '原有题源仍是人工/API 接入');
});

test('待审列表：只返回爬取且待审的任务', () => {
  const list = store.listPending({ limit: 50 });
  assert.ok(list.length >= 1);
  for (const o of list) {
    assert.equal(o.origin, 'crawled');
    assert.equal(o.status, 'pending_review');
    assert.ok(o.source_name, '带出题源名称供后台展示');
  }
});
