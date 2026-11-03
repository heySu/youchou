'use strict';
/**
 * 风控引擎。
 * 每条规则受 risk_rules.enabled 控制；命中即记录 risk_events 并累加 hits。
 */
const { db, now } = require('./db');

function ruleEnabled(key) {
  const r = db.prepare('SELECT enabled FROM risk_rules WHERE key = ?').get(key);
  return r ? r.enabled === 1 : true;
}

function recordHit(ruleKey, userId, sessionId, detail) {
  db.prepare('UPDATE risk_rules SET hits = hits + 1 WHERE key = ?').run(ruleKey);
  db.prepare('INSERT INTO risk_events(user_id, session_id, rule_key, detail, created_at) VALUES(?,?,?,?,?)')
    .run(userId || null, sessionId || null, ruleKey, detail || null, now());
}

/**
 * @returns {Array<{key:string, detail:string}>} 命中的规则
 */
function evaluate({ userId, sessionId, questions, answers, durationMs, deviceId, duplicate }) {
  const flags = [];

  // 1. 答题时长
  if (ruleEnabled('speed')) {
    const perQ = questions.length ? durationMs / questions.length : 0;
    if (durationMs < 20000 || perQ < 2000) {
      flags.push({
        key: 'speed',
        detail: `总时长 ${Math.round(durationMs / 1000)}s，单题均值 ${(perQ / 1000).toFixed(1)}s`
      });
    }
  }

  // 2. 注意力校验题
  if (ruleEnabled('attention')) {
    questions.forEach((q, i) => {
      if (!q.attn) return;
      const a = answers[i];
      const picked = typeof a === 'number' ? q.opts[a] : undefined;
      if (picked !== q.attentionAnswer) {
        flags.push({ key: 'attention', detail: `第 ${i + 1} 题期望「${q.attentionAnswer}」，实际「${picked ?? '未作答'}」` });
      }
    });
  }

  // 3. 答案直线化
  if (ruleEnabled('straightline')) {
    const picks = [];
    answers.forEach((a, i) => {
      const q = questions[i];
      if (q && (q.type === 'single' || q.type === 'scale') && typeof a === 'number') picks.push(a);
    });
    if (picks.length >= 4) {
      const freq = {};
      picks.forEach(p => { freq[p] = (freq[p] || 0) + 1; });
      const max = Math.max(...Object.values(freq));
      if (max / picks.length >= 0.8) {
        flags.push({ key: 'straightline', detail: `${max}/${picks.length} 道单选题选择同一位置` });
      }
    }
  }

  // 4. 设备指纹聚集
  if (ruleEnabled('device') && deviceId) {
    const row = db.prepare('SELECT COUNT(*) AS c FROM users WHERE device_id = ?').get(deviceId);
    if (row.c >= 3) {
      flags.push({ key: 'device', detail: `同一设备指纹关联 ${row.c} 个账号` });
    }
  }

  // 5. 同源重复提交
  if (ruleEnabled('duplicate') && duplicate) {
    flags.push({ key: 'duplicate', detail: '该用户此前已提交过同一问卷' });
  }

  flags.forEach(f => recordHit(f.key, userId, sessionId, f.detail));
  return flags;
}

function listRules() {
  return db.prepare('SELECT key, name, description, enabled, hits FROM risk_rules ORDER BY rowid').all()
    .map(r => ({ ...r, enabled: r.enabled === 1 }));
}

module.exports = { evaluate, listRules, ruleEnabled };
