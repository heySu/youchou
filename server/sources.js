'use strict';
/**
 * 题源适配层（模拟网络）。
 *
 * 真实环境下，题源在用户完成后由「对方的服务端」回调我们的 /api/postback/:key。
 * 这里用一个本地模拟器做同一件事：按题源密钥签名，然后真的发起一次 HTTP POST。
 * 因此验签、幂等、日志、状态流转走的都是生产同一条代码路径。
 */
const { db } = require('./db');
const { hmacSign } = require('./auth');

let BASE_URL = null;
const setBaseUrl = url => { BASE_URL = url; };

const getSource = key => db.prepare('SELECT * FROM sources WHERE key = ?').get(key);

function buildPayload({ transactionId, offerId, userRef, payoutCents, status = 'complete' }) {
  return {
    transaction_id: transactionId,
    survey_id: offerId,
    user_ref: String(userRef),
    status,
    payout: Number((payoutCents / 100).toFixed(2)),
    currency: 'CNY',
    timestamp: Math.floor(Date.now() / 1000)
  };
}

async function sendPostback(sourceKey, payload, attempt = 1) {
  const src = getSource(sourceKey);
  if (!src) throw new Error('unknown source: ' + sourceKey);
  const signature = hmacSign(src.secret, payload);
  const body = JSON.stringify({ ...payload, signature });

  const res = await fetch(`${BASE_URL}/api/postback/${sourceKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  const text = await res.text();
  if (res.status >= 500 && attempt < 3) {
    await new Promise(r => setTimeout(r, 200 * attempt));
    return sendPostback(sourceKey, payload, attempt + 1);
  }
  return { status: res.status, body: text };
}

/**
 * 用户提交答卷后，题源在若干秒后回调确认。
 * 这是演示环境里「等待题源结算」的真实来源。
 */
function scheduleSimulatedPostback({ sourceKey, transactionId, offerId, userRef, payoutCents, delayMs }) {
  // 测试环境可关闭自动回调，由用例显式驱动 Postback
  if (process.env.AUTO_POSTBACK === '0') return null;
  const delay = delayMs != null ? delayMs : Number(process.env.SIM_POSTBACK_DELAY_MS || 4000);
  const timer = setTimeout(async () => {
    try {
      const payload = buildPayload({ transactionId, offerId, userRef, payoutCents });
      await sendPostback(sourceKey, payload);
    } catch (e) {
      // 服务已关闭（如测试结束时）不再刷错误日志
      if (e && e.cause && e.cause.code === 'ECONNREFUSED') return;
      console.error('[postback] 模拟回调失败:', e.message);
    }
  }, delay);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { setBaseUrl, getSource, buildPayload, sendPostback, scheduleSimulatedPostback };
