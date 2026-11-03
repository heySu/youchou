const BASE = 'http://127.0.0.1:3000';
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const api = (p, opt = {}, token) => fetch(BASE + p, {
  ...opt,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opt.headers || {}) }
}).then(j);

(async () => {
  const phone = '139' + String(Date.now()).slice(-8);
  const reg = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ phone, password: '123456', name: '冒烟测试' }) });
  console.log('register:', reg.status, reg.body.user ? 'ok id=' + reg.body.user.id : JSON.stringify(reg.body));
  const token = reg.body.token;

  const offers = await api('/api/offers', {}, token);
  console.log('offers:', offers.status, 'count=' + offers.body.offers.length, 'first=' + offers.body.offers[0].title, 'reward=' + offers.body.offers[0].reward);

  const target = offers.body.offers.find(o => o.id === 'sx-105');
  const sess = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ offerId: target.id }) }, token);
  console.log('session:', sess.status, sess.body.sessionId, 'questions=' + sess.body.offer.questions.length);
  console.log('  attention 字段是否泄露:', JSON.stringify(sess.body.offer.questions).includes('attentionAnswer') ? '❌ 泄露' : '✅ 已剔除');

  const qs = sess.body.offer.questions;
  const answers = qs.map(q => {
    if (q.type === 'multi') return [0, 1];
    if (q.type === 'text') return '这是一条测试回答';
    return 0;
  });

  const resp = await api('/api/responses', { method: 'POST', body: JSON.stringify({ sessionId: sess.body.sessionId, answers }) }, token);
  if (!resp.body || !resp.body.commission) {
    console.log('submit FAILED:', resp.status, JSON.stringify(resp.body));
  } else {
    console.log('submit:', resp.status, 'status=' + resp.body.commission.status, 'flags=' + JSON.stringify(resp.body.commission.flags.map(f => f.key)), 'duration=' + resp.body.durationMs + 'ms');
  }

  const w1 = await api('/api/wallet', {}, token);
  console.log('wallet:', JSON.stringify(w1.body));

  await new Promise(r => setTimeout(r, 6000));
  const cs = await api('/api/commissions', {}, token);
  console.log('commissions after postback:', cs.body.commissions.map(c => c.id + ':' + c.status + ':' + c.reward).join(', '));

  const dup = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ offerId: target.id }) }, token);
  console.log('duplicate session:', dup.status, dup.body.error ? dup.body.error.code : '');

  const wd = await api('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount: 100, channel: 'wechat' }) }, token);
  console.log('withdraw below min:', wd.status, wd.body.error ? wd.body.error.code : '');

  const admin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: 'admin', password: 'admin123' }) });
  const at = admin.body.token;
  const ov = await api('/api/admin/overview', {}, at);
  console.log('admin overview:', ov.status, 'todayReward=' + ov.body.today.reward, 'margin=' + ov.body.today.margin + '%', 'reviewQueue=' + ov.body.review.count);
  const forbidden = await api('/api/admin/overview', {}, token);
  console.log('user hitting admin api:', forbidden.status, forbidden.body.error ? forbidden.body.error.code : '');
})();
