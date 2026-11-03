'use strict';
/**
 * 归一化：把各适配器吐出来的原始条目，整理成入库需要的统一形状。
 *
 * 这里刻意不做「猜佣金」「猜时长」这类补全。爬到的页面没有的信息
 * 就是没有，宁可留空让运营定价，也不要在数据里塞编造的数字。
 * 唯一允许的推断是分类，因为它只影响筛选体验，不影响钱。
 */

const CATEGORY_RULES = [
  { name: '教育', words: ['学生', '家长', '大学', '学校', '老师', '教师', '教育', '课程', '考试', '培训', '作业', '校园', '毕业', '考研'] },
  { name: '职场', words: ['工作', '职场', '员工', '招聘', '办公', '职业', '薪资', '加班', '同事', '远程', '创业', '就业', '面试'] },
  { name: '消费', words: ['消费', '购物', '购买', '品牌', '价格', '电商', '产品', '广告', '营销', '优惠', '外卖', '网购', '零售'] },
  { name: '科技', words: ['科技', '手机', '互联网', '人工智能', 'AI', '软件', '数码', '电脑', 'App', 'APP', '应用', '算法', '智能', '网络'] },
  { name: '娱乐', words: ['娱乐', '影视', '电影', '游戏', '音乐', '视频', '综艺', '明星', '动漫', '直播', '追剧', '短视频'] },
  { name: '生活', words: ['健康', '饮食', '出行', '旅游', '住房', '家庭', '医疗', '睡眠', '运动', '宠物', '婚恋', '养老', '社区'] },
  { name: '社会', words: ['社会', '公共', '政策', '环境', '公益', '城市', '乡村', '文化', '调查', '民意', '现状', '看法'] }
];

const MIN_TITLE_LEN = 4;
const MAX_TITLE_LEN = 80;

/** 去掉营销尾巴与多余空白：「XX调查问卷【已结束】」→「XX调查问卷」 */
function cleanTitle(raw) {
  let t = String(raw || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();

  t = t.replace(/[（(\[【][^）)\]】]{0,8}(已结束|已关闭|停止|截止|过期|下线)[^）)\]】]{0,4}[）)\]】]\s*$/g, '').trim();
  t = t.replace(/\s*[-_|·—]{1,3}\s*问卷星\s*$/g, '').trim();

  return t.slice(0, MAX_TITLE_LEN).trim();
}

/** 判断这条是否值得入库。返回 null 表示通过，否则返回跳过原因 */
function rejectReason(title) {
  const t = String(title || '').trim();
  if (!t) return 'empty_title';
  if (t.length < MIN_TITLE_LEN) return 'title_too_short';
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(t)) return 'no_letters';
  if (/^(测试|test|111|123)/i.test(t) && t.length < 8) return 'looks_like_test';
  return null;
}

function guessCategory(title) {
  const t = String(title || '');
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some(w => t.includes(w))) return rule.name;
  }
  return '社会';
}

function buildTags({ title, isNew }) {
  const tags = [];
  if (isNew) tags.push('新抓取');
  if (/有偿|红包|奖励|礼品|抽奖|佣金/.test(title)) tags.push('有奖励');
  if (/问卷|调研|调查/.test(title)) tags.push('问卷');
  if (title.length > 30) tags.push('长标题');
  return tags.slice(0, 3);
}

/** 入库主键：来源可读、可回溯，避免和站内自带问卷的 sx-* 冲突 */
function buildOfferId(sourceKey, externalId) {
  return `cr_${sourceKey}_${String(externalId).replace(/[^\w-]/g, '').slice(0, 40)}`;
}

/**
 * 把适配器的原始输出规范成统一结构。
 * 没有的字段保持 null，交给运营在后台补。
 *
 * 返回值是扁平对象：成功时带 skip:null，被过滤时只有 skip:<原因>。
 * 这样调用方可以一条 map 走完，不用再拆包装。
 */
function normalizeItem(raw, { sourceKey, now, knownIds }) {
  const title = cleanTitle(raw.title);
  const reason = rejectReason(title);
  if (reason) return { skip: reason };

  if (!raw.externalId) return { skip: 'missing_external_id' };
  if (!raw.url || !/^https?:\/\//i.test(raw.url)) return { skip: 'bad_url' };

  const externalId = String(raw.externalId);
  return {
    skip: null,
    id: buildOfferId(sourceKey, externalId),
    sourceKey,
    externalId,
    title,
    externalUrl: raw.url,
    description: raw.description
      ? String(raw.description).slice(0, 240)
      : `来自题源「${raw.sourceName || sourceKey}」的公开问卷，点击前往原站完成。`,
    category: raw.category || guessCategory(title),
    tags: buildTags({ title, isNew: !knownIds || !knownIds.has(externalId) }),
    minutes: Number.isFinite(raw.minutes) && raw.minutes > 0 ? Math.round(raw.minutes) : null,
    payCents: Number.isFinite(raw.payCents) && raw.payCents > 0 ? Math.round(raw.payCents) : null,
    publishedAt: raw.publishedAt || null,
    fetchedAt: now
  };
}

module.exports = {
  cleanTitle, rejectReason, guessCategory, buildTags, buildOfferId, normalizeItem,
  CATEGORY_RULES, MIN_TITLE_LEN, MAX_TITLE_LEN
};
