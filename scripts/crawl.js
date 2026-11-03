'use strict';
/**
 * 抓取命令行入口。
 *
 *   npm run crawl                 抓所有已配置为 adapter 的题源
 *   npm run crawl -- wjx          只抓指定题源
 *   npm run crawl -- wjx --pages 5  指定最多翻几页
 *
 * 放在脚本里而不是只在后台按钮里，是为了能挂 cron：
 *   每 6 小时跑一次 → "0 每6小时" 的 crontab 表达式，
 *   形如  `0 0,6,12,18 星号 星号 星号` 这种五段式（星号处填 *）
 *   命令：cd /path/to/youchou && npm run crawl >> logs/crawl.log 2>&1
 */

const crawler = require('../server/crawler');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const maxPages = arg('--pages') ? Number(arg('--pages')) : undefined;

  const label = target ? `题源 ${target}` : '全部可抓题源';
  console.log(`开始抓取：${label}${maxPages ? `（最多 ${maxPages} 页）` : ''}`);
  console.log('');

  if (target) {
    const r = await crawler.runCrawl(target, { maxPages });
    printOne(r);
  } else {
    const s = await crawler.runAll({ maxPages });
    for (const r of s.results) printOne(r);
    console.log('');
    console.log(`合计 ${s.total} 个题源｜成功 ${s.succeeded}｜失败 ${s.failed}｜新增 ${s.inserted} 条`);
  }
})().catch(e => {
  console.error('抓取异常：', e.message);
  process.exit(1);
});

function printOne(r) {
  if (r.ok) {
    console.log(`  ✓ ${r.sourceKey}（${r.adapter}） ${r.pages} 页｜解析 ${r.found}｜新增 ${r.inserted}｜更新 ${r.updated}｜跳过 ${r.skipped}｜${r.durationMs}ms`);
  } else {
    console.log(`  ✗ ${r.sourceKey}（${r.adapter}） 失败：${r.error}`);
  }
}
