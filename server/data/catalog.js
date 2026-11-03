'use strict';
/**
 * 题源与问卷目录（种子数据）。
 * 金额单位：分。
 */

const SOURCES = [
  { key:'x',     name:'X (Twitter)', glyph:'X',  color:'#14181C', mode:'hybrid',   pay_cents: 920, status:'active',  secret:'sk_x_demo_secret' },
  { key:'yt',    name:'YouTube',     glyph:'▶',  color:'#E0272B', mode:'hybrid',   pay_cents:1680, status:'active',  secret:'sk_yt_demo_secret' },
  { key:'yahoo', name:'Yahoo',       glyph:'Y!', color:'#5F01D1', mode:'offerwall',pay_cents: 560, status:'active',  secret:'sk_yahoo_demo_secret' },
  { key:'fb',    name:'Facebook',    glyph:'f',  color:'#1877F2', mode:'hybrid',   pay_cents:1950, status:'limited', secret:'sk_fb_demo_secret' },
  { key:'tt',    name:'TikTok',      glyph:'♪',  color:'#0B0B0B', mode:'api',      pay_cents: 480, status:'active',  secret:'sk_tt_demo_secret' },
  { key:'rd',    name:'Reddit',      glyph:'r/', color:'#FF4500', mode:'postback', pay_cents:2300, status:'limited', secret:'sk_rd_demo_secret' },
  { key:'li',    name:'LinkedIn',    glyph:'in', color:'#0A66C2', mode:'hybrid',   pay_cents:1280, status:'active',  secret:'sk_li_demo_secret' },
  { key:'sp',    name:'Spotify',     glyph:'♪',  color:'#1DB954', mode:'offerwall',pay_cents: 720, status:'paused',  secret:'sk_sp_demo_secret' },

  // 真实可抓取的公开题源。crawl_type='adapter' 表示由 server/crawler 定时抓取任务清单，
  // 用户点击后前往原站完成，平台只做聚合与核销，不复制原站题目。
  {
    key: 'wjx',
    name: '问卷星',
    glyph: '问',
    color: '#2E7D32',
    mode: 'crawl',
    pay_cents: 900,
    status: 'active',
    secret: 'sk_wjx_demo_secret',
    crawl_type: 'adapter',
    homepage: 'https://www.wjx.cn/newsurveys.aspx',
    default_pay_cents: 900,
    crawl_config: {
      adapter: 'wjx',
      board: 'newsurveys',
      maxPages: 3,
      minGapMs: 1500
    }
  }
];

const ATT = {
  type: 'single',
  attn: true,
  q: '为了保证数据质量，本题请直接选择「比较同意」。',
  opts: ['非常不同意', '比较不同意', '一般', '比较同意', '非常同意'],
  attentionAnswer: '比较同意'
};

const OFFERS = [
  {
    id: 'sx-101', source_key: 'x', title: '社交媒体与科技品牌认知调研',
    description: '了解你在 X 平台上对 AI / 科技品牌的关注度与互动习惯，用于品牌健康度追踪。',
    minutes: 5, reward_cents: 680, pay_cents: 920, total_quota: 120, left_quota: 38,
    tags: ['新题', '高匹配'], category: '科技',
    questions: [
      { type:'single', q:'过去 7 天，你使用 X（推特）的频率是？', opts:['每天多次','每天大约 1 次','每周 3–5 次','更少或没有'] },
      { type:'multi', max:3, q:'你通常在 X 上关注哪些类型的内容？（最多选 3 项）', opts:['科技 / AI','财经与加密','娱乐八卦','体育','游戏','新闻时事','品牌官方账号'] },
      { type:'scale', q:'「我愿意为 AI 工具持续付费」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'single', q:'你最近一次在 X 上看到品牌广告是什么时候？', opts:['今天','本周内','本月内','完全想不起来'] },
      { type:'multi', max:2, q:'哪些因素最可能促使你点击一条广告？（最多选 2 项）', opts:['创意有趣','有折扣或试用','关注的达人推荐','评论区口碑好','品牌本身就熟悉'] },
      ATT,
      { type:'text', q:'用一个词或一句话形容你对「AI 硬件」的印象', placeholder:'例如：新鲜但还不太实用', min:2 }
    ]
  },
  {
    id: 'sx-102', source_key: 'yt', title: '长视频观看习惯与广告容忍度',
    description: '关于观看时长、内容分区与贴片广告接受度的调研，结果用于视频平台内容策略优化。',
    minutes: 8, reward_cents: 1250, pay_cents: 1690, total_quota: 200, left_quota: 64,
    tags: ['高收益'], category: '娱乐',
    questions: [
      { type:'single', q:'你平均每天在视频平台观看内容的时长是？', opts:['少于 30 分钟','30–60 分钟','1–2 小时','2 小时以上'] },
      { type:'multi', max:3, q:'你最常观看的分区是？（最多选 3 项）', opts:['影视解说','科技数码','美食','游戏实况','知识科普','音乐现场','vlog 生活'] },
      { type:'single', q:'你主要在什么设备上观看长视频？', opts:['手机','平板','电脑','电视 / 投屏'] },
      { type:'scale', q:'「我可以接受每 10 分钟出现一次 15 秒贴片广告」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'single', q:'你是否愿意为「免广告」单独付费？', opts:['已经在付费','愿意，但价格要低','不愿意，广告可以忍','说不清'] },
      { type:'multi', max:2, q:'什么情况下你会把一条 10 分钟以上的视频看完？（最多选 2 项）', opts:['内容真的有用','开头很抓人','主播是我常看的','陪伴感，当背景音','很少看完'] },
      ATT,
      { type:'text', q:'最近一次完整看完的长视频主题是什么？', placeholder:'例如：某款手机的拆解评测', min:2 }
    ]
  },
  {
    id: 'sx-103', source_key: 'yahoo', title: '资讯阅读与邮箱使用习惯',
    description: '3 分钟快问快答，用于门户资讯推荐策略与邮箱产品体验优化。',
    minutes: 3, reward_cents: 420, pay_cents: 570, total_quota: 400, left_quota: 212,
    tags: ['快答'], category: '生活',
    questions: [
      { type:'single', q:'你获取每日新闻的主要渠道是？', opts:['资讯 App 推送','社交平台','搜索引擎','朋友分享'] },
      { type:'single', q:'你平均每天阅读资讯的时长？', opts:['10 分钟以内','10–30 分钟','30–60 分钟','1 小时以上'] },
      { type:'multi', max:2, q:'你最关注的资讯类型？（最多选 2 项）', opts:['时政','财经','科技','生活健康','体育娱乐'] },
      { type:'scale', q:'「个性化推荐比编辑精选更适合我」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'single', q:'你目前最常使用的邮箱是？', opts:['QQ 邮箱','网易邮箱','Gmail','公司邮箱','几乎不用邮箱'] }
    ]
  },
  {
    id: 'sx-104', source_key: 'fb', title: '跨境购物与社交广告触达调研',
    description: '面向有跨境购物经历的用户，了解广告触达路径与决策影响因素，单份报酬较高。',
    minutes: 10, reward_cents: 1500, pay_cents: 2030, total_quota: 80, left_quota: 12,
    tags: ['高收益', '配额紧张'], category: '消费',
    questions: [
      { type:'single', q:'过去 6 个月，你是否有过跨境网购经历？', opts:['有，3 次以上','有，1–2 次','有浏览但没下单','完全没有'] },
      { type:'multi', max:3, q:'你购买过的跨境品类有哪些？（最多选 3 项）', opts:['美妆个护','母婴','保健品','数码配件','服饰鞋包','食品'] },
      { type:'single', q:'你主要通过什么渠道发现跨境商品？', opts:['社交平台信息流','达人测评','朋友推荐','电商平台搜索'] },
      { type:'scale', q:'「社交平台上的广告比搜索广告更懂我」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'multi', max:2, q:'决定你是否下单的关键因素？（最多选 2 项）', opts:['价格与折扣','正品保障','物流时效','退换方便','品牌口碑'] },
      { type:'single', q:'你能接受的跨境物流时长是？', opts:['7 天内','7–14 天','14–30 天','只要便宜，多久都行'] },
      ATT,
      { type:'text', q:'如果让你吐槽一次跨境购物体验，你会说什么？', placeholder:'例如：清关太慢、包装破损', min:2 }
    ]
  },
  {
    id: 'sx-105', source_key: 'tt', title: '短视频音乐与挑战赛偏好',
    description: '关于短视频配乐偏好与话题挑战赛参与度的轻量问卷。',
    minutes: 3, reward_cents: 360, pay_cents: 490, total_quota: 500, left_quota: 286,
    tags: ['快答', '新题'], category: '娱乐',
    questions: [
      { type:'single', q:'你平均每天刷短视频的时长？', opts:['30 分钟以内','30–60 分钟','1–2 小时','2 小时以上'] },
      { type:'multi', max:2, q:'你在意视频背景音乐的程度？（最多选 2 项）', opts:['音乐会决定我看不看','会跟着找歌单','几乎不注意','会自己配乐'] },
      { type:'scale', q:'「我愿意参与品牌发起的话题挑战赛」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'single', q:'你更愿意参与哪种挑战赛？', opts:['简单跟拍模板','原创才艺展示','剧情演绎','不愿意参与'] },
      { type:'text', q:'写下你最近单曲循环的一首歌', placeholder:'歌名或歌手都可以', min:2 }
    ]
  },
  {
    id: 'sx-106', source_key: 'rd', title: '开发者社区与技术选型调研',
    description: '面向有编程经验的用户，关于技术栈、社区参与与工具付费意愿的深度调研。',
    minutes: 12, reward_cents: 1800, pay_cents: 2430, total_quota: 60, left_quota: 7,
    tags: ['高收益', '配额紧张'], category: '科技',
    questions: [
      { type:'single', q:'你的主要开发方向是？', opts:['前端 / 客户端','后端 / 服务端','数据与算法','运维 / SRE','非开发岗'] },
      { type:'multi', max:3, q:'你常用的编程语言有哪些？（最多选 3 项）', opts:['JavaScript / TypeScript','Python','Go','Java','Rust','C++','其他'] },
      { type:'single', q:'你获取技术信息的主要来源？', opts:['Reddit / Hacker News','GitHub','技术博客与公众号','视频教程','同事与社群'] },
      { type:'scale', q:'「我愿意为提升效率的开发工具付费」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'multi', max:2, q:'你目前在用哪些 AI 编程工具？（最多选 2 项）', opts:['Copilot 类补全','对话式助手','Agent 自动改代码','暂时没用'] },
      { type:'single', q:'你对 AI 生成代码的信任度？', opts:['完全信任，直接合并','会逐行检查','只用于样板代码','基本不用'] },
      ATT,
      { type:'text', q:'你最近在折腾的一个技术项目是什么？', placeholder:'例如：给自己的博客接一个 AI 摘要', min:2 }
    ]
  },
  {
    id: 'sx-107', source_key: 'li', title: '职场技能与在线学习意愿',
    description: '了解职场人群的技能提升路径与付费学习意愿，用于在线教育产品定价研究。',
    minutes: 7, reward_cents: 990, pay_cents: 1340, total_quota: 150, left_quota: 41,
    tags: ['高匹配'], category: '职场',
    questions: [
      { type:'single', q:'你的工作年限是？', opts:['1 年以内','1–3 年','3–5 年','5–10 年','10 年以上'] },
      { type:'single', q:'你所在的企业规模？', opts:['20 人以下','20–200 人','200–2000 人','2000 人以上'] },
      { type:'multi', max:2, q:'你今年最想提升的能力是？（最多选 2 项）', opts:['AI 工具应用','数据分析','英语','管理与沟通','专业硬技能'] },
      { type:'scale', q:'「公司应该为员工的技能培训付费」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'single', q:'你能接受的单门课程价格区间？', opts:['100 元以内','100–500 元','500–2000 元','2000 元以上'] },
      { type:'text', q:'你最近一次主动学习是在学什么？', placeholder:'例如：用 Python 做数据清洗', min:2 }
    ]
  },
  {
    id: 'sx-108', source_key: 'sp', title: '音频订阅与播客收听调研',
    description: '关于音乐 / 播客订阅习惯与付费意愿的调研，约 4 分钟。',
    minutes: 4, reward_cents: 550, pay_cents: 740, total_quota: 260, left_quota: 97,
    tags: ['新题'], category: '娱乐',
    questions: [
      { type:'single', q:'你每天听音频内容的时长？', opts:['少于 20 分钟','20–60 分钟','1–3 小时','3 小时以上'] },
      { type:'multi', max:2, q:'你最常听的内容类型？（最多选 2 项）', opts:['流行音乐','播客 / 访谈','有声书','白噪音 / 助眠','相声评书'] },
      { type:'single', q:'你目前是否为音乐订阅付费？', opts:['是，长期订阅','用过，已取消','从未付费','用家庭共享账号'] },
      { type:'scale', q:'「播客是我获取信息的重要方式」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'single', q:'你能接受的月度订阅价格？', opts:['8 元以内','8–15 元','15–25 元','25 元以上'] },
      { type:'text', q:'推荐一档你最近在听的播客或歌单', placeholder:'名称即可', min:2 }
    ]
  },
  {
    id: 'sx-109', source_key: 'x', title: '出行方式与网约车使用习惯',
    description: '了解城市通勤方式选择与网约车使用频率，用于出行平台用户研究。',
    minutes: 4, reward_cents: 520, pay_cents: 700, total_quota: 320, left_quota: 143,
    tags: ['快答'], category: '生活',
    questions: [
      { type:'single', q:'你日常通勤的主要方式是？', opts:['地铁 / 公交','自驾','网约车 / 出租车','骑行或步行','远程办公'] },
      { type:'single', q:'你平均每周使用网约车的次数？', opts:['几乎不用','1–2 次','3–5 次','6 次以上'] },
      { type:'multi', max:2, q:'你选择网约车最看重什么？（最多选 2 项）', opts:['价格','等待时间','车型与舒适度','司机评分','安全记录'] },
      { type:'scale', q:'「我愿意为更快接单支付溢价」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'text', q:'你最近一次打车是因为什么事？', placeholder:'例如：赶高铁', min:2 }
    ]
  },
  {
    id: 'sx-110', source_key: 'fb', title: '家庭消费与母婴决策调研',
    description: '面向有 0–6 岁子女的家庭，了解母婴品类决策链路与广告触达，报酬较高。',
    minutes: 9, reward_cents: 1100, pay_cents: 1490, total_quota: 90, left_quota: 26,
    tags: ['高收益'], category: '消费',
    questions: [
      { type:'single', q:'你家中是否有 0–6 岁的孩子？', opts:['有，0–1 岁','有，1–3 岁','有，3–6 岁','没有'] },
      { type:'multi', max:3, q:'近半年买过的母婴品类？（最多选 3 项）', opts:['奶粉辅食','纸尿裤','洗护用品','玩具早教','童装童鞋','推车安全座椅'] },
      { type:'single', q:'你获取母婴产品信息的主要渠道？', opts:['社交平台种草','亲友推荐','电商平台搜索','母婴店导购'] },
      { type:'scale', q:'「我会为「成分更安全」支付 30% 以上的溢价」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'multi', max:2, q:'什么内容最容易打动你下单？（最多选 2 项）', opts:['真实测评对比','医生 / 专家背书','同龄宝妈分享','大促折扣'] },
      ATT,
      { type:'text', q:'你在母婴消费上踩过最大的坑是什么？', placeholder:'例如：买了很多用不上的玩具', min:2 }
    ]
  },
  {
    id: 'sx-111', source_key: 'li', title: '远程办公与协作工具调研',
    description: '关于混合办公模式、协作工具选型与付费意愿的职场调研。',
    minutes: 6, reward_cents: 880, pay_cents: 1190, total_quota: 180, left_quota: 72,
    tags: ['高匹配'], category: '职场',
    questions: [
      { type:'single', q:'你目前的办公模式是？', opts:['完全坐班','每周 1–2 天远程','每周 3–4 天远程','完全远程'] },
      { type:'multi', max:3, q:'你日常使用的协作工具有哪些？（最多选 3 项）', opts:['飞书 / 钉钉','企业微信','Slack','Notion','在线文档','视频会议'] },
      { type:'scale', q:'「远程办公时我的产出比坐班更高」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'single', q:'你所在团队是否为协作工具付费？', opts:['已付费且够用','已付费但不够用','只用免费版','不清楚'] },
      { type:'text', q:'远程办公最让你头疼的一件事是什么？', placeholder:'例如：跨时区沟通成本', min:2 }
    ]
  },
  {
    id: 'sx-112', source_key: 'tt', title: '本地生活到店消费偏好',
    description: '关于短视频种草到店消费的转化路径与决策因素，约 4 分钟。',
    minutes: 4, reward_cents: 450, pay_cents: 610, total_quota: 420, left_quota: 198,
    tags: ['新题', '快答'], category: '消费',
    questions: [
      { type:'single', q:'你过去一个月是否因短视频去过线下门店？', opts:['有，3 次以上','有，1–2 次','有想法但没去','完全没有'] },
      { type:'multi', max:2, q:'哪类到店内容最容易让你心动？（最多选 2 项）', opts:['餐饮探店','美甲美发','健身运动','亲子娱乐','景点打卡'] },
      { type:'scale', q:'「团购套餐比原价更吸引我」——你的认同程度是？', opts:['非常不同意','不同意','一般','比较同意','非常同意'] },
      { type:'single', q:'你能接受的单人餐客单价是？', opts:['50 元以内','50–100 元','100–200 元','200 元以上'] },
      { type:'text', q:'最近一次被种草后到店的店是什么？', placeholder:'店名或品类', min:2 }
    ]
  }
];

const RISK_RULES = [
  { key:'speed',       name:'答题时长下限',   description:'单题平均用时 < 2 秒，或整卷 < 20 秒，判定为异常提交', enabled:1 },
  { key:'attention',   name:'注意力校验题',   description:'问卷内埋入校验题，答案不符即标记', enabled:1 },
  { key:'straightline',name:'答案直线化检测', description:'单一选项占比 ≥ 80%，判定为敷衍作答', enabled:1 },
  { key:'device',      name:'设备指纹去重',   description:'同一设备指纹下注册账号 ≥ 3 个，全部标记', enabled:1 },
  { key:'duplicate',   name:'同源重复答卷',   description:'同一用户对同一问卷重复提交，仅计首次', enabled:1 }
];

module.exports = { SOURCES, OFFERS, RISK_RULES };
