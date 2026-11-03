'use strict';
/**
 * 有酬 · 问卷佣金平台 —— HTTP 服务入口。
 * 零外部依赖：node:http / node:sqlite / node:crypto。
 */
const http = require('node:http');
const path = require('node:path');
const { Router, HttpError, sendJson, readBody, serveStatic } = require('./lib/http');
const { verifyToken } = require('./auth');
const session = require('./session');
const { db, DB_PATH } = require('./db');
const sources = require('./sources');
const commission = require('./commission');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SETTLE_INTERVAL_MS = Number(process.env.SETTLE_INTERVAL_MS || 5000);
const SESSION_SWEEP_MS = 60 * 60 * 1000;

function buildRouter() {
  const router = new Router();
  require('./routes/auth')(router);
  require('./routes/offers')(router);
  require('./routes/wallet')(router);
  require('./routes/admin')(router);
  require('./routes/postback')(router);

  router.get('/api/health', async () => ({
    ok: true,
    db: DB_PATH,
    freezeMs: commission.FREEZE_MS,
    time: new Date().toISOString()
  }));

  return router;
}

function createServer() {
  const router = buildRouter();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 静态资源
    if (!pathname.startsWith('/api/')) {
      if (serveStatic(PUBLIC_DIR, pathname, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const matched = router.match(req.method, pathname);
    if (!matched) {
      sendJson(res, 404, { error: { code: 'not_found', message: `接口不存在: ${req.method} ${pathname}` } });
      return;
    }

    const ctx = {
      req,
      res,
      params: matched.params,
      query: url.searchParams,
      body: {},
      status: 200,
      ip: req.socket.remoteAddress,
      user: null
    };

    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const payload = verifyToken(auth.slice(7));
      if (payload) {
        // 令牌只证明「是谁签的」，会话才决定「还能不能用」
        const sess = session.verify(payload.sid, payload.uid);
        if (sess) {
          const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
          if (u && (!u.status || u.status === 'active')) {
            ctx.user = u;
            ctx.sid = payload.sid;
            session.touch(payload.sid, sess.last_seen_at);
          }
        }
      }
    }

    try {
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        ctx.body = await readBody(req);
      }
      const out = await matched.route.handler(ctx);
      if (res.writableEnded) return;
      sendJson(res, ctx.status, out === undefined ? { ok: true } : out);
    } catch (e) {
      if (res.writableEnded) return;
      if (e instanceof HttpError) {
        const err = { code: e.code, message: e.message };
        if (e.extra) Object.assign(err, e.extra);
        sendJson(res, e.status, { error: err });
      } else {
        console.error('[500]', req.method, pathname, e);
        sendJson(res, 500, { error: { code: 'internal_error', message: '服务器内部错误' } });
      }
    }
  });

  server.on('listening', () => {
    const { port } = server.address();
    sources.setBaseUrl(`http://127.0.0.1:${port}`);
  });

  return server;
}

let settleTimer = null;
let sessionSweepTimer = null;
function startSettlementTimer() {
  if (settleTimer) return settleTimer;
  settleTimer = setInterval(() => {
    try {
      const r = commission.runSettlement();
      if (r.released > 0) console.log(`[settle] 解冻 ${r.released} 笔佣金`);
    } catch (e) {
      console.error('[settle] 结算任务失败', e.message);
    }
  }, SETTLE_INTERVAL_MS);
  if (settleTimer.unref) settleTimer.unref();

  // 过期会话清理，避免会话表随登录次数无限增长
  try { session.cleanup(); } catch (e) { console.error('[session] 清理失败', e.message); }
  sessionSweepTimer = setInterval(() => {
    try {
      const n = session.cleanup();
      if (n > 0) console.log(`[session] 清理 ${n} 条过期会话`);
    } catch (e) {
      console.error('[session] 清理失败', e.message);
    }
  }, SESSION_SWEEP_MS);
  if (sessionSweepTimer.unref) sessionSweepTimer.unref();

  return settleTimer;
}

function stopSettlementTimer() {
  if (settleTimer) clearInterval(settleTimer);
  if (sessionSweepTimer) clearInterval(sessionSweepTimer);
  settleTimer = null;
  sessionSweepTimer = null;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    startSettlementTimer();
    console.log('');
    console.log('  有酬 · 问卷佣金平台');
    console.log('  ─────────────────────────────────');
    console.log(`  用户端    http://127.0.0.1:${port}/`);
    console.log(`  运营后台  http://127.0.0.1:${port}/console.html`);
    console.log(`  健康检查  http://127.0.0.1:${port}/api/health`);
    console.log(`  数据库    ${DB_PATH}`);
    console.log(`  冻结期    ${commission.FREEZE_MS / 1000}s（生产环境应设为 86400s）`);
    console.log('  抓取模式  手动：仅在后台点击「抓取最新题源」或执行 npm run crawl 时抓取，启动不自动抓取');
    console.log('');
  });

  const shutdown = () => {
    console.log('\n正在关闭服务…');
    stopSettlementTimer();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, startSettlementTimer, stopSettlementTimer };
