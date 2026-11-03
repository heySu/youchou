# 优酬 YouChou — 问卷佣金平台

整合多家海外题源（X、YouTube、Yahoo、Facebook、TikTok、Reddit、LinkedIn、Spotify）的问卷聚合平台。用户在站内完成问卷，题源通过 S2S Postback 回传转化结果，平台据此结算佣金，用户提现到微信零钱 / 支付宝。

**当前状态：真实可运行的全栈系统**，不是静态原型。前端调用真实 API，数据落在 SQLite，佣金流转有状态机和账本约束，51 个集成测试全部通过。题源侧带一个真实爬虫子系统，能从公开站点抓取真实问卷任务，抓取只在手动点击「抓取最新题源」时发生、启动不自动抓取。后台是 RBAC 权限模型，四个角色职责分离，所有动钱动权限的操作都有审计。

---

## 快速开始

环境要求：**Node.js 22+**（依赖内置 `node:sqlite`，无需任何 npm 依赖，不需要 `npm install`）。

```bash
cd youchou

npm run seed     # 建库 + 写入 9 家题源 / 12 份站内问卷 / 5 条风控规则 / 体验数据
npm start        # 启动服务，默认 http://localhost:3000
npm test         # 跑 50 个集成测试（独立临时库，不影响开发数据）
npm run crawl    # 抓取真实题源任务（联网，可选；也可以点后台的「抓取最新题源」）
```

打开两个入口：

| 入口 | 地址 | 账号 |
| --- | --- | --- |
| 用户端 | http://localhost:3000/ | `13800000001` / `demo123456` |
| 运营后台 | http://localhost:3000/console.html | `admin` / `admin12345` |

后台另有三个分权账号，用来验证职责分离：

| 账号 | 密码 | 角色 | 能做什么 |
| --- | --- | --- | --- |
| `admin` | `admin12345` | 超级管理员 | 全部权限 |
| `operator` | `op123456` | 运营 | 题源启停、触发抓取、任务上架定价 |
| `reviewer` | `rv123456` | 审核员 | 佣金复核、风控查看、提现单只读 |
| `finance` | `fn123456` | 财务 | 结算解冻、提现打款（**不能**复核佣金） |

体验账号初始有 可用 ¥31.70、冻结 ¥18.00、累计 ¥69.70，可直接体验提现流程（已实名）。

---

## 技术栈

刻意选择**零外部依赖**：任何装了 Node 22 的机器 `git clone` 后即可运行，不依赖 npm 源、不依赖原生编译（`better-sqlite3` 在 Windows 上经常编译失败）。

| 层 | 选型 | 说明 |
| --- | --- | --- |
| HTTP 服务 | `node:http` | 自写极简路由（`server/lib/http.js` 中的 `Router`，支持 `:param` 与中间件） |
| 数据库 | `node:sqlite` `DatabaseSync` | WAL 模式、`foreign_keys=ON`、同步 API + 手写事务包装 |
| 密码 | `crypto.scryptSync` | 每用户随机 salt，`timingSafeEqual` 比对 |
| 令牌 | HMAC-SHA256 自签 | `base64url(payload).signature`，带 `sid` 与过期时间，服务端可吊销 |
| 授权 | 自写 RBAC | 18 个权限点 × 5 个角色，接口只声明权限点，不判断角色 |
| 验签 | `crypto.createHmac` | Postback 签名校验 |
| 前端 | 原生 HTML + CSS + JS | 无框架、无构建步骤，直接由服务端静态托管 |
| 测试 | `node:test` + `node:assert` | 内置测试运行器，起真实 HTTP 服务打真实接口 |

---

## 目录结构

```
youchou/
├── package.json
├── README.md
├── data/
│   └── youchou.db              # SQLite 数据文件（seed 生成，勿提交生产数据）
├── server/
│   ├── index.js                # createServer / 静态托管 / 结算定时器 / 优雅退出
│   ├── db.js                   # 建表、连接、嵌套事务 tx()
│   ├── auth.js                 # scrypt 散列、密码策略、token 签发校验、hmacSign 验签工具
│   ├── session.js              # 登录会话：签发 / 校验 / 吊销 / 我的设备 / 过期清理
│   ├── wallet.js               # 余额变动唯一入口（6 个原子操作）
│   ├── commission.js           # 佣金状态机 + 结算任务
│   ├── risk.js                 # 风控规则引擎（5 条规则）
│   ├── sources.js              # 题源适配层 + 模拟回调（真实发 HTTP）
│   ├── seed.js                 # 种子数据（--reset 清库重建）
│   ├── data/catalog.js         # 题源 / 问卷 / 风控规则定义
│   ├── crawler/                # 题源抓取子系统
│   │   ├── index.js            # 调度：读配置 → 选适配器 → 抓 → 归一化 → 入库 → 记日志
│   │   ├── http.js             # 抓取层：超时 / 重试 / 按站点限速 / charset 解码
│   │   ├── robots.js           # robots.txt 解析与最长前缀判定
│   │   ├── parse.js            # 极简 HTML 工具（取链接、取文本、按块切分）
│   │   ├── normalize.js        # 标题清洗、脏数据过滤、分类推断、主键生成
│   │   ├── store.js            # upsert 去重、抓取日志、统计
│   │   └── adapters/
│   │       ├── index.js        # 适配器注册表
│   │       ├── wjx.js          # 问卷星公开问卷（实测可用）
│   │       └── generic.js      # 配置式适配器（URL 模板 + 正则）
│   ├── lib/
│   │   ├── http.js             # Router 路由分发、HttpError、JSON 响应、body 解析、静态托管
│   │   ├── rbac.js             # 权限点定义、角色矩阵、hasPermission
│   │   ├── authz.js            # requireUser / requirePermission / assertCanManage / identity
│   │   └── audit.js            # 审计写入与查询、设备标签解析
│   └── routes/
│       ├── auth.js             # 注册 / 登录 / 续期 / 登出 / 改密 / 登录设备
│       ├── offers.js           # 问卷池 / 开题 / 提交答卷
│       ├── wallet.js           # 钱包 / 流水 / 佣金 / 提现 / 实名 / 统计
│       ├── admin.js            # 后台接口（含抓取、提现打款、成员与权限、审计查询）
│       └── postback.js         # S2S 回调接收端
├── public/
│   ├── app.html                # 用户端（单文件，含全部页面状态 + 账号安全）
│   └── console.html            # 运营后台（单文件，导航按权限裁剪）
├── tests/
│   ├── api.test.js             # 15 个接口与账本测试
│   ├── auth.test.js            # 16 个权限 / 会话 / 打款 / 审计测试
│   ├── crawl.test.js           # 20 个爬虫测试（离线，用 fixtures）
│   └── fixtures/
│       └── wjx-list.html       # 真实列表页片段，供解析测试使用
└── scripts/
    ├── crawl.js                # 抓取 CLI（可挂 cron）
    └── smoke.js                # 手动冒烟脚本（可选）
```

---

## 数据模型

17 张表，全部建在 `server/db.js`。老库升级走 `migrate()`（PRAGMA 查列后补 ALTER），重复执行无副作用。

**核心实体**

- `users` — 用户（`role`: user/operator/reviewer/finance/admin，`status`: active/disabled，`credit_score`，`real_name` 实名标记，`device_id` 设备指纹，`failed_count` / `locked_until` 登录锁定，`last_login_at`）
- `wallets` — 钱包，一人一行。三个字段三个口径：`available_cents` 可提现、`pending_cents` 冻结中、`total_cents` 累计收益
- `wallet_txns` — 流水（append-only），`kind`: `pending_in` / `available_in` / `withdraw_out` / `reject_out` / `adjust`

**业务链路**

- `sources` — 题源接入配置（`mode`: hybrid/offerwall/api/postback，`secret` 验签密钥，`status`: active/limited/paused）。抓取相关：`crawl_type`（manual/adapter）、`crawl_config`（适配器参数 JSON）、`default_pay_cents`、`homepage`、`last_crawled_at`
- `offers` — 问卷（`pay_cents` 题源结算价、`reward_cents` 用户佣金、`minutes` 预计时长、`quota` 配额、`questions_json`）。来源相关：`origin`（seed/crawled）、`external_id` / `external_url`（题源侧唯一 ID 与地址）、`delivery`（inline 站内答题 / external 跳原站）、`fetched_at`、`review_note`
- `sessions` — 开题会话（`started_at` 服务端开题时间，是计时的唯一依据）
- `responses` — 答卷原文 + 命中的风控标记
- `commissions` — 佣金单，`transaction_id` 唯一索引即幂等键
- `postback_logs` — 全部回调原文留痕（含验签失败的）

**运营侧**

- `withdrawals` — 提现单（`status`: pending 待打款 / paid 已打款 / failed 打款失败并已退款）
- `risk_rules` / `risk_events` — 风控规则开关与命中事件
- `crawl_logs` — 每次抓取的统计与错误（页数、解析条数、新增、更新、跳过、耗时）
- `settings` — 键值配置

**安全**

- `auth_sessions` — 登录会话（`id` 即令牌里的 `sid`，`revoked_at` 非空即失效，带 IP / UA / 设备标签 / 最近活跃时间）
- `login_attempts` — 登录尝试流水（账号 + IP + 结果 + 原因），用于锁定计数与撞库排查
- `audit_logs` — 操作审计，`result` 区分 ok / denied / failed，`detail_json` 存变更前后

`offers` 上有一条**部分唯一索引**，这是爬虫去重的底座：

```sql
CREATE UNIQUE INDEX ux_offer_external ON offers(source_key, external_id)
  WHERE external_id IS NOT NULL;
```

站内自带问卷的 `external_id` 为 NULL，不受该索引约束；爬来的任务同一题源同一 ID 只会有一条。

### 两条硬约束

**金额全部以「分」为整数存储**，任何地方不出现浮点，避免 `0.1 + 0.2` 类误差累积。

**钱包不变式**，由测试守护（`账本不变式：余额自洽、流水与提现一致`）：

```
available + pending === total - withdrawn
```

任何导致该等式不成立的写入路径都是 bug。

---

## 佣金状态机

```
                    ┌──────────── 题源 reversal ────────────┐
                    ▼                                       │
created ──► pending ──► approved ──► available ──► paid     │
              │            │                                │
              │ 风控命中    │ 人工驳回                        │
              ▼            ▼                                │
          reviewing ───────┴──────────► rejected ◄──────────┘
              │
              └── 审核通过 ──► approved
```

| 状态 | 含义 | 触发者 |
| --- | --- | --- |
| `pending` | 用户已提交，等题源确认 | 提交答卷 |
| `reviewing` | 风控命中，扣在人工复核 | 风控引擎 |
| `approved` | 题源 Postback 确认转化 | **仅** Postback 接口 |
| `available` | 冻结期结束，可提现 | 结算定时任务 |
| `rejected` | 驳回 / 题源 screenout，冻结金额退回 | 人工 / Postback |
| `reversed` | 已入账后被题源冲正 | Postback reversal |

**关键设计：用户提交不等于佣金成立。** 提交只产生 `pending`（进 `pending_cents`），必须等题源 S2S 回调确认才进 `approved`，再过冻结期才进 `available`。这条链路保证平台不会为未确认的转化垫付。

`approved` 状态**只有** `server/routes/postback.js` 有权写入，管理后台也没有「直接置为 approved」的口子，防止绕过题源对账。

### 冻结期

冻结期默认 **60 秒**（`FREEZE_MS`），便于演示。结算定时器每 5 秒扫一次（`SETTLE_INTERVAL_MS`），把 `approved` 且 `approved_at + FREEZE_MS` 已到期的单子推成 `available` 并写流水。

**生产必须改为 `FREEZE_MS=86400000`**（24 小时）。理由：题源的反作弊回扫和冲正通常发生在上报后数小时内，冻结期是平台的唯一止损窗口。

---

## 权限与安全

分四层，每一层解决一类问题：

```
认证   密码散列（scrypt + 每用户 salt + timingSafeEqual）
  ↓
会话   令牌带 sid，服务端每次回查；可吊销、可踢设备、可全端下线
  ↓
授权   18 个权限点 × 5 个角色；接口只声明权限点，不判断角色
  ↓
审计   所有写操作与越权尝试落 audit_logs，只增不改
```

### 为什么令牌要带会话表

纯无状态令牌发出去就收不回：改密码、禁用账号、怀疑泄露，都只能等它自然过期。所以令牌里放一个 `sid`，每个请求回查一次 `auth_sessions`——多一次主键查询，换来「能立刻让某个令牌失效」。

- 令牌有效期 **12 小时**（`TOKEN_TTL_MS`），到期用 `/api/auth/refresh` 续，会话仍在才允许
- 会话有效期 **7 天**（`SESSION_TTL_MS`），到期必须重新登录
- 以下动作会立即吊销会话：改密码（保留当前设备）、被踢、被禁用、角色变更、全端下线

### 权限点

命名统一为 `资源:动作`，动作按破坏力递增：`view` < `review`/`run` < `manage`。

| 资源 | 权限点 |
| --- | --- |
| 看板 | `dashboard:view` |
| 题源 | `source:view`、`source:manage` |
| 抓取 | `crawl:view`、`crawl:run` |
| 任务 | `offer:view`、`offer:review` |
| 佣金 | `commission:view`、`commission:review`、`settle:run` |
| 风控 | `risk:view`、`risk:manage` |
| 回调 | `postback:view` |
| 提现 | `withdrawal:view`、`withdrawal:pay` |
| 成员 | `member:view`、`member:manage` |
| 审计 | `audit:view` |

### 角色矩阵

| 权限点 | 运营 | 审核员 | 财务 | 超管 |
| --- | :-: | :-: | :-: | :-: |
| dashboard:view | ● | ● | ● | ● |
| source:view / manage | ● / ● | ● / · | · / · | ● |
| crawl:view / run | ● / ● | ● / · | · / · | ● |
| offer:view / review | ● / ● | ● / · | · / · | ● |
| commission:view / review | ● / · | ● / ● | ● / · | ● |
| settle:run | · | · | ● | ● |
| risk:view / manage | · | ● / · | · / · | ● |
| postback:view | · | ● | ● | ● |
| withdrawal:view / pay | · | ● / · | ● / ● | ● |
| member:view / manage | · | · | · | ● |
| audit:view | · | · | · | ● |

三条刻意的「不给」：

- **财务能打款但不能复核佣金**。审核和付款是同一笔钱的两端，一个人全包等于没有内控。
- **审核员能看提现单但不能打款**。看得见是为了核对，打得出去是另一回事。
- **运营能改题源和定价，但碰不到钱也碰不到风控**。风控开关只在超管手里，因为关掉一条规则就是放水。

接口层面的写法是 `requirePermission(ctx, 'withdrawal:pay')`，不是 `if (role === 'admin')`。加角色不用改任何路由。

### 登录防护

- 同一账号连续失败 **5 次锁 15 分钟**，锁定期间正确密码也拒绝，返回剩余秒数（`429 account_locked`）
- 登录失败统一回「账号或密码错误」，不区分「账号不存在」，避免账号枚举
- 失败流水写 `login_attempts`（账号 + IP + 结果），可按 IP 排查撞库
- 管理员可在后台「成员与权限」解除锁定

### 密码策略

注册与改密码都过 `checkPassword`：至少 6 位、不超过 64 位、拦截常见弱口令（`123456`、`password`、`admin123` 等）、拦截纯重复字符、纯数字需 8 位以上。

> 因为这条策略，演示密码从 `123456` 改成了 `demo123456` / `admin12345`。种子账号是运维直接写库的初始凭据，正常流程下用户需要自行改密。

### 审计

`audit_logs` 记录：谁（id / 姓名 / 角色）、何时、从哪个 IP 和设备、做了什么（`action`）、对谁（`target`）、变更前后（`detail_json`）、结果（`ok` / `denied` / `failed`）。

**越权尝试也记**。有人拿审核员的令牌去调打款接口，即使被 403 拦下，这条记录也必须留下——这是发现内部风险最有效的信号。后台「操作审计」可按动作与结果筛选，24 小时越权次数直接显示在 KPI 上。

审计表没有写接口（`POST /api/admin/audit-logs` 返回 404），只由服务端内部写入，应用层无法篡改。

### 前端只负责藏，不负责挡

后台登录后拉 `/api/me` 拿权限数组：没权限的导航直接不渲染，页内按钮（上架、打款、复核、风控开关）按权限显示为只读或「无权限」。

这层只是体验优化。**真正的判定全在服务端**——把前端按钮全删掉，接口依然会按权限返回 403 并写审计。

---

## API 清单

统一前缀 `/api`，认证走 `Authorization: Bearer <token>`。错误响应形如 `{ "error": "code", "message": "中文提示" }`。

另有一个无需认证的 `GET /api/health`，返回服务状态、当前库路径和生效的冻结期，用于存活探针。

### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册，返回 token + 用户信息 + 钱包 |
| POST | `/api/auth/login` | 登录。`admin: true` 时拒绝非后台角色；连续失败 5 次锁 15 分钟 |
| POST | `/api/auth/refresh` | 换一张新令牌（会话仍有效才允许） |
| POST | `/api/auth/logout` | 退出当前设备（吊销该会话） |
| POST | `/api/auth/logout-all` | 退出所有设备 |
| POST | `/api/auth/password` | 改密码，同时吊销其他设备 |
| GET | `/api/auth/sessions` | 我的登录设备列表 |
| DELETE | `/api/auth/sessions/:id` | 踢掉某台设备 |
| GET | `/api/auth/permissions` | 当前角色与权限清单 |
| GET | `/api/me` | 当前用户（含展开后的权限数组） |

### 问卷

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/offers` | 问卷池，含题源品牌信息、已答状态、配额余量；**不返回**风控答案字段 |
| GET | `/api/offers/:id` | 单份问卷详情（题目已剔除 `attentionAnswer`） |
| POST | `/api/sessions` | 开题，返回 `sessionId`；同一问卷未完成时不可重复开题 |
| POST | `/api/responses` | 提交答卷：服务端计时 → 风控评估 → 建佣金单 → 触发题源回调 |

### 钱包与提现

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wallet` | 余额三口径 |
| GET | `/api/wallet/txns` | 流水（倒序分页） |
| GET | `/api/commissions` | 我的佣金单列表 |
| POST | `/api/withdrawals` | 提现 |
| POST | `/api/me/realname` | 实名认证（提现前置条件） |
| GET | `/api/me/stats` | 个人统计（完成数、累计、信用分） |

### 运营后台

括号里是该接口要求的**权限点**，不是角色。角色只是权限点的打包。

| 方法 | 路径 | 权限点 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/overview` | `dashboard:view` | 概览：今日 KPI、7 日趋势、题源表现、实时回调（自带，不再单请求其他接口） |
| GET | `/api/admin/sources` | `source:view` | 题源列表与对账数据（含抓取配置与最近抓取时间） |
| PATCH | `/api/admin/sources/:key` | `source:manage` | 改题源状态 / 抓取方式 / 抓取配置 / 默认单价 |
| GET | `/api/admin/offers` | `offer:view` | 问卷维度的转化与毛利 |
| POST | `/api/admin/offers/:id/review` | `offer:review` | 审核爬取任务：上架定价 / 忽略 |
| GET | `/api/admin/crawl` | `crawl:view` | 抓取面板：适配器能力、统计、待审任务、最近日志 |
| POST | `/api/admin/crawl` | `crawl:run` | 触发抓取。`{sourceKey}` 抓单个，不传则抓全部 |
| GET | `/api/admin/crawl-logs` | `crawl:view` | 抓取日志，可按 `?source=wjx&limit=30` 过滤 |
| GET | `/api/admin/commissions` | `commission:view` | 佣金单查询（可按状态筛） |
| POST | `/api/admin/commissions/:id/review` | `commission:review` | 复核单条（approve/reject + 备注） |
| POST | `/api/admin/commissions/bulk-approve` | `commission:review` | 批量通过低风险 |
| POST | `/api/admin/settle` | `settle:run` | 手动触发结算解冻 |
| GET | `/api/admin/risk-rules` | `risk:view` | 风控规则清单 |
| PATCH | `/api/admin/risk-rules/:key` | `risk:manage` | 风控规则开关（**仅超管**） |
| GET | `/api/admin/risk-events` | `risk:view` | 风控命中事件 |
| GET | `/api/admin/postbacks` | `postback:view` | 回调日志（含验签失败） |
| GET | `/api/admin/withdrawals` | `withdrawal:view` | 提现单列表与合计 |
| PATCH | `/api/admin/withdrawals/:id/pay` | `withdrawal:pay` | 打款 / 标记失败（失败自动退款） |
| GET | `/api/admin/members` | `member:view` | 成员列表（含在线设备数、锁定状态） |
| GET | `/api/admin/roles` | `member:view` | 角色与权限矩阵 |
| PATCH | `/api/admin/members/:id/role` | `member:manage` | 改角色，立即踢下线 |
| PATCH | `/api/admin/members/:id/status` | `member:manage` | 启用 / 禁用 |
| POST | `/api/admin/members/:id/unlock` | `member:manage` | 解除登录锁定 |
| POST | `/api/admin/members/:id/logout` | `member:manage` | 强制该成员全端下线 |
| GET | `/api/admin/audit-logs` | `audit:view` | 操作审计，可按 `?action=&result=&actorId=` 筛 |

`POST /api/admin/crawl` 是同步等待结果的：单源通常 1-5 秒返回本次抓取的统计（页数、解析数、新增、更新），前端不需要轮询。

### S2S Postback

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/postback/:sourceKey` | 题源回调，验签后推进佣金状态 |

---

## 题源接入规范（S2S Postback）

题源侧配置回调地址：

```
POST https://your-domain.com/api/postback/{sourceKey}
Content-Type: application/json
```

请求体：

```json
{
  "transaction_id": "txn_9f2c1a",
  "status": "complete",
  "payout": "1950",
  "user_ref": "u_88123",
  "timestamp": "1730558400",
  "signature": "3f9a...e21c"
}
```

`status` 取值：`complete`（转化成立）/ `screenout`（用户不符条件）/ `reversal`（事后冲正）。

### 签名算法

1. 去掉 `signature` 字段；
2. 其余参数按 **key 字典序** 排列，拼成 `k1=v1&k2=v2&...`；
3. 末尾追加 `&key={题源密钥}`；
4. 对整串做 `HMAC-SHA256`，输出小写 hex。

```js
const crypto = require('node:crypto');
function hmacSign(secret, params) {
  const keys = Object.keys(params).sort();
  const base = keys.map(k => `${k}=${params[k]}`).join('&') + `&key=${secret}`;
  return crypto.createHmac('sha256', secret).update(base).digest('hex');
}
```

实现见 `server/auth.js` 与 `server/routes/postback.js`。

### 服务端校验顺序

1. **题源存在** → 否则 404 `unknown_source`
2. **验签** → 否则 401 `invalid_signature`，并留痕
3. **时间窗** → `timestamp` 与服务器时间偏差超过 ±300 秒则 400 `expired`，防重放
4. **幂等** → 未知单号 / 重复回调**一律返回 200**，让题源停止重试。`transaction_id` 上有唯一索引，重复回调不会二次入账
5. `reviewing` 且 `complete` → 返回 `awaiting_review`，佣金仍留在人工队列，等审核结论

所有回调（包括验签失败）都写入 `postback_logs`，后台「回调与对账」页可查。这是处理题源纠纷的唯一证据链。

### 本地演示回调

`server/sources.js` 的 `scheduleSimulatedPostback` 会**真实发起 HTTP POST** 打到自己的 `/api/postback/:key`，走的是与生产完全相同的代码路径（验签、时间窗、幂等、日志一个不少）。所以本地看到的每次状态流转，逻辑都与线上一致。

测试中设置 `AUTO_POSTBACK=0` 关闭自动回调，由测试用例显式驱动，避免竞态。

---

## 题源抓取

题源有两条路，不要把两者混为一谈：

| 方式 | 适用 | 佣金结算 | 本项目的状态 |
| --- | --- | --- | --- |
| **API 合作** | 正式商务对接的 panel（有合同、有 postback 协议） | 走 S2S Postback，自动到账 | 适配器骨架已留，需对方 key |
| **公开抓取** | 公开展示的问卷任务（无需登录即可见） | 平台定价 + 运营核销 | **已实现并可运行** |

这一节讲的是后者。

### 触发方式：纯手动，启动不抓

**打开系统不会自动抓取任何题源。** 服务启动只做三件事：建表迁移、起 HTTP 服务、启动佣金结算定时器，不碰爬虫。抓取只有两个入口：

| 入口 | 说明 |
| --- | --- |
| 后台「抓取最新题源」按钮 | 「题源接入」和「题源抓取」两页右上角都有；命中 `crawl:run` 权限才显示，调用 `POST /api/admin/crawl`，同步返回本次统计 |
| 命令行 `npm run crawl` | 供 cron / 运维脚本使用，参数 `-- wjx --pages 2` 可只抓单源、限制页数 |

后台面板上的「题源抓取」页只读取统计和日志（`GET /api/admin/crawl`），刷新页面、切换导航都不会产生抓取行为——这一点有测试守着（`系统启动不自动抓取：初始化后无抓取日志、无爬取来源任务`）。

### 抓取链路

```
读题源配置 → 选适配器 → robots 校验 → 限速抓取 → 解析条目
  → 归一化（清洗/过滤/分类） → 按 (source_key, external_id) 去重入库
  → 状态置 pending_review → 写 crawl_logs
  → 运营在后台审核 → 定价上架 → 任务大厅可见
```

关键点：**爬来的任务不直接进大厅**。默认落 `pending_review`，必须运营审核定价后才上架。爬虫只负责「把市场上有什么搬进来看一眼」，上不上架、给多少钱是人决定的。

### 已实现的适配器

**`wjx` — 问卷星公开问卷**（`server/crawler/adapters/wjx.js`）

抓 `https://www.wjx.cn/newsurveys.aspx`，这个页面不需要登录、robots 允许、支持 `?pagenumber=N` 翻页。每条解析出问卷 ID、标题、详情页地址。

```bash
npm run crawl -- wjx --pages 2
#   ✓ wjx（wjx） 2 页｜解析 70｜新增 70｜更新 0｜跳过 0｜3187ms
```

实测一页约 36 条，翻两页 70 条（跨页去重后）。

**`generic` — 配置式适配器**（`adapters/generic.js`）

不是每个站都值得写一个文件。给一个 URL 模板加两条正则，就能接一个列表型页面：

```json
{
  "listUrl": "https://example.com/surveys?page={page}",
  "maxPages": 3,
  "linkPattern": "href=\"(https://example\\.com/s/(\\d+))\"[^>]*>([^<]{4,80})<",
  "urlGroup": 1, "idGroup": 2, "titleGroup": 3
}
```

这段配置存在 `sources.crawl_config` 里，改配置不用改代码、不用重启。

### 适配器接口

新写一个适配器只要实现一个函数：

```js
module.exports = {
  key: 'example',
  name: '示例题源',
  async crawl(ctx) {
    // ctx.fetch(url, opts) 已带 robots 校验、限速、重试、字符集解码
    const res = await ctx.fetch('https://example.com/list');
    const items = parse.anchors(res.body)
      .filter(a => /\/survey\/\d+/.test(a.href))
      .map(a => ({
        externalId: a.href.match(/(\d+)/)[1],
        title: a.text,
        url: a.href
      }));
    return { items, pages: 1, detail: { note: '自定义信息，会存进日志' } };
  }
};
```

然后在 `adapters/index.js` 注册表里挂一行。`externalId` 是去重键，必须稳定。

### 抓取纪律

爬虫最容易出的事不是解析错，是把人家站点打挂然后被封 IP。所以默认就带这几层约束：

- **robots.txt 优先**：每个请求前校验，`Disallow` 命中直接返回 `blocked`，记进日志而不是硬闯
- **同站串行 + 最小间隔 1.2s**（`Crawl-delay` 更大时用 `Crawl-delay`）
- **429 / 5xx 退避重试**，最多 2 次，尊重 `Retry-After`
- **15 秒超时**，避免卡住整个批量任务
- **按 charset 解码**，国内站点还有 GBK，一律 UTF-8 会得到乱码标题
- **自定义 UA**，标明身份和联系方式

单源抓取失败不会影响其他源：`runAll` 逐个串行执行，异常收敛成一条 `failed` 日志。

### 去重与「不覆盖运营改价」

这是入库层最容易写错的地方。规则是：

| 字段 | 重复抓到时 |
| --- | --- |
| 标题、链接、描述、分类、标签 | 跟着题源刷新 |
| `reward_cents`（用户佣金） | **不动**，运营定的价说了算 |
| `pay_cents`（结算价） | **不动** |
| `status` | **不动**，已上架不会被打回待审 |

第二次抓取同一批数据只会得到 `updated: N, inserted: 0`，库里条数不变。这一点有测试守着（`入库：运营改过的价格与状态不会被下一次抓取覆盖`）。

页面拿不到的字段保持 `null`，不编造：没有时长就 `minutes = 0`（前端显示「原站作答」），没有佣金就用题源 `default_pay_cents` 兜底并由运营确认。

### 两种交付模式

| `delivery` | 含义 | 用户看到 |
| --- | --- | --- |
| `inline` | 站内自带题库，原生答题 | 「6 分钟 · 5 题」+「去答题」 |
| `external` | 题目在原站，平台只做聚合与核销 | 「原站作答」+「去完成」，点击开新窗 |

外部任务点「去完成」会弹确认框说明「该问卷由题源提供，完成后回来提交凭证，运营核销后入账」，然后跳转原站。**不复制对方题目**，也不假装站内能答。

### 接入一个新题源

1. 判断页面结构：是列表型（能用 `generic` 配置解决）还是需要专门解析（写 adapter）
2. `PATCH /api/admin/sources/:key` 设 `crawl_type: 'adapter'` 和 `crawl_config`
3. 后台点「抓取最新题源」，看返回的 `found / inserted / skipped` 和日志里的 `skipReasons`
4. 审核上架，观察任务大厅

### 合规边界

抓取只做**元信息聚合**：标题、链接、分类、抓取时间。不做这些事：

- 不抓取、不存储、不复制原站问卷的题目内容（版权属发布者）
- 不绕过登录、不破解验证码、不伪造 UA 冒充浏览器绕反爬
- 不忽略 robots.txt
- 不把爬来的问卷包装成「平台自有问卷」

平台在这里的角色是**导航与核销**，不是内容复制。这条线划清楚，模式才站得住。

---

## 风控引擎

5 条规则，均可在后台单独开关（`risk_rules.enabled`）。

| key | 规则 | 判定 |
| --- | --- | --- |
| `speed` | 答题时长下限 | 单题均时 < 2 秒，或整卷 < 20 秒 |
| `attention` | 注意力校验题 | 问卷内埋校验题，答案不符 |
| `straightline` | 答案直线化 | 单一选项占比 ≥ 80% |
| `device` | 设备指纹聚集 | 同设备注册账号 ≥ 3 个 |
| `duplicate` | 同源重复答卷 | 同一用户对同一问卷重复提交，仅计首次 |

**计时以服务端为准**：`Date.now() - session.started_at`，客户端传来的时长一概不采信，改系统时间或发请求都不影响判定。

命中任一规则 → 佣金单进 `reviewing`，不进 `pending`。复核通过后才走正常结算，驳回则冻结金额原路退回。

所有命中写入 `risk_events`，后台可按规则维度看命中率，用于调阈值。

---

## 提现规则

| 项 | 值 |
| --- | --- |
| 起提金额 | ¥20（`MIN_WITHDRAW = 2000`） |
| 单笔上限 | ¥500（`MAX_WITHDRAW = 50000`） |
| 日累计上限 | ¥2000（`DAILY_LIMIT = 200000`） |
| 渠道 | `wechat` / `alipay` |
| 前置条件 | 必须已实名 |

校验顺序：金额 → 渠道 → 实名（403）→ 可用余额 → 日额度。扣减用条件更新 `WHERE available_cents >= ?` 并检查 `changes`，并发提现不会超扣。

提现是**两步走**：

```
用户提交  → 立刻扣可用余额，提现单落 pending（钱还在平台账上）
财务打款  → 后台「提现打款」确认，状态变 paid，写审计
打款失败  → 标记 failed，金额原路退回可用余额并记一条 adjust 流水
```

不能一步落 `paid`：钱还没出去却标「已支付」，对账时对不上，也没法处理渠道退回。打款权限 `withdrawal:pay` 只给财务和超管，审核员能看不能打。

---

## 测试

```bash
npm test
```

51 个测试，分三组：**接口与账本**（`api.test.js`，15 个）、**权限与会话**（`auth.test.js`，16 个）、**爬虫**（`crawl.test.js`，20 个，含 1 条「启动不自动抓取」回归）。三组都跑在独立临时数据库（`os.tmpdir()`，随进程清理）上，不读写开发数据。

测试通过环境变量改了三件事，保证用例可重复：`DB_PATH` 指向临时库、`FREEZE_MS=0` 免去等待冻结期、`AUTO_POSTBACK=0` 关闭自动回调改由用例显式驱动（否则定时回调与断言顺序会产生竞态）。

| # | 用例 | 验证点 |
| --- | --- | --- |
| 1 | 健康检查与未登录访问 | 401 拦截 |
| 2 | 注册 / 重复注册 / 错误密码 | 手机号唯一、密码散列校验 |
| 3 | 问卷池：含题源信息、不泄露风控答案、暂停题源不出现 | 字段裁剪正确 |
| 4 | 开题锁配额，重复开题被拒绝 | 会话唯一性 |
| 5 | 提交答卷：服务端计时 + 风控命中答题过快 | `speed` 规则生效，进 `reviewing` |
| 6 | 注意力校验题答错会被拦截 | `attention` 规则生效 |
| 7 | 非法答卷被拒（题数不符 / 选项越界 / 空文本） | 入参校验 |
| 8 | 干净答卷：pending → Postback 确认 approved → 解冻 available | 主链路闭环 |
| 9 | Postback 验签失败被拒绝，且不改变佣金状态 | 签名 + 状态原子性 |
| 10 | Postback 幂等：重复回调不重复入账 | 唯一索引 + 余额不变 |
| 11 | 人工复核：通过 / 驳回 / 状态约束 | 复核权限与状态机约束 |
| 12 | 提现：门槛、余额、额度、成功后扣减 | 五级校验顺序 |
| 13 | 账本不变式：余额自洽、流水与提现一致 | 对账等式 |
| 14 | 权限隔离：普通用户不能访问后台 | RBAC |
| 15 | 后台概览与风控规则可读写 | 后台接口可用性 |

**权限与会话子测试**（`tests/auth.test.js`，16 个）：

| # | 用例 | 验证点 |
| --- | --- | --- |
| 16 | 登录返回展开后的权限清单 | 超管拿到全量权限点 |
| 17 | 各角色权限边界 | 财务无 `commission:review`、审核无 `withdrawal:pay` |
| 18 | 权限矩阵：越权一律 403 且写审计 | 9 组越权用例，每次都留痕 |
| 19 | 有权限的请求正常放行 | 七个角色 × 接口组合 |
| 20 | 概览只依赖 `dashboard:view` | 财务看首页不触发 `source:view` |
| 21 | 普通用户走后台入口被拒 | 403 + 权限数组为空 |
| 22 | 会话可吊销：踢掉设备后旧令牌失效 | `sid` 一票否决 |
| 23 | 改密码后其他设备下线、旧密码失效 | 保留当前设备 |
| 24 | 弱口令 / 相同密码 / 原密码错误被拒 | 密码策略 |
| 25 | 失败 5 次锁 15 分钟，管理员可解锁 | 429 + `retryAfter` |
| 26 | 改角色立即生效并踢下线；不能动自己或超管 | 越级防护 |
| 27 | 禁用账号立即踢下线，禁用后无法登录 | 状态即权限 |
| 28 | 成员列表带在线设备数与锁定状态 | 后台数据来源 |
| 29 | 提现落 pending，打款才 paid；失败退款 | 两步走 + 退款 + 留痕 |
| 30 | 审计可按动作与结果筛选，且不可写入 | 只读接口 |
| 31 | 登录与退出都留痕 | 审计完整性 |

**爬虫子测试**（`tests/crawl.test.js`，20 个，全部离线）：

| # | 用例 | 验证点 |
| --- | --- | --- |
| 16 | robots：前缀匹配与最长优先 | `Allow` 长于 `Disallow` 时放行 |
| 17 | robots：指定 UA 分组优先于通配分组 | 不被别人的 `Disallow: /` 误伤 |
| 18 | robots：无匹配分组时默认放行 | 兜底行为 |
| 19 | wjx：从真实列表页片段解析出任务 | ID / URL / 标题格式与导航文本过滤 |
| 20 | wjx：同页重复内容不产生重复条目 | 页内按 ID 去重 |
| 21 | 归一化：标题清洗去掉营销尾巴 | `【已结束】`、站点后缀 |
| 22 | 归一化：脏数据被拦下 | 空标题 / 过短 / 无字母 |
| 23 | 归一化：分类按关键词推断 | 教育 / 娱乐 / 职场 / 兜底社会 |
| 24 | 归一化：拿不到的字段留空，不编造 | `minutes`/`payCents` 为 null |
| 25 | 归一化：缺 ID 或非法 URL 直接跳过 | 跳过原因可解释 |
| 26 | 通用适配器：按配置正则解析列表 | 分组取 URL / ID / 标题 |
| 27 | 通用适配器：没有 listUrl 时明确报错 | 配置缺失不静默 |
| 28 | 入库：首次插入，重复抓取只更新 | `inserted 2 → 0 / updated 2` |
| 29 | 入库：默认待审、外部交付、题源默认价兜底 | `pending_review` + `delivery=external` |
| 30 | 入库：运营改价与状态不被抓取覆盖 | 佣金/结算价/状态均保持 |
| 31 | 入库：脏条目计入 skipped 并给出原因 | `skipReasons` 统计 |
| 32 | 抓取日志：写入可读回并刷新 `last_crawled_at` | 日志与题源状态联动 |
| 33 | 统计：区分待审 / 已上架 / 爬取来源 | 后台 KPI 数据来源正确 |
| 34 | 待审列表：只返回爬取且待审的任务 | 过滤条件正确 |

爬虫测试**不联网**：解析用 `tests/fixtures/wjx-list.html`（从真实页面截取的片段），入库用临时库。这样 CI 不会因为对方改版或网络抖动而变红。真实联网验证走 `npm run crawl`。

手动冒烟：

```bash
node scripts/smoke.js      # 接口冒烟
npm run crawl -- wjx       # 真实抓取一次（联网）
```

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DB_PATH` | `./data/youchou.db` | SQLite 文件路径 |
| `FREEZE_MS` | `60000` | 佣金冻结期（毫秒）。**生产建议 86400000** |
| `SETTLE_INTERVAL_MS` | `5000` | 结算任务扫描间隔 |
| `SIM_POSTBACK_DELAY_MS` | `4000` | 模拟题源回调延迟 |
| `AUTO_POSTBACK` | 启用 | 设为 `0` 关闭自动回调（测试用） |
| `TOKEN_SECRET` | 自动生成 | 令牌签名密钥。**生产必须显式设置** |
| `TOKEN_TTL_MS` | `43200000`（12 小时） | 令牌有效期，到期用 `/api/auth/refresh` 续 |
| `SESSION_TTL_MS` | `604800000`（7 天） | 会话绝对有效期，到期必须重新登录 |
| `LOCK_THRESHOLD` | `5` | 连续登录失败多少次锁定 |
| `LOCK_MS` | `900000`（15 分钟） | 锁定时长 |
| `CRAWLER_UA` | `YouChouBot/1.0 (...)` | 爬虫 User-Agent，生产建议填真实联系方式 |
| `CRAWL_DEBUG` | 关闭 | 设为 `1` 打印抓取过程日志 |

`TOKEN_SECRET` 不设置时每次启动随机生成，进程重启后所有已签发 token 失效。生产务必固定。

---

## 生产部署清单

上线前必须处理（当前都是演示配置）：

1. **`FREEZE_MS=86400000`** — 冻结期 60 秒只适用于演示，线上给出 24 小时止损窗口
2. **`TOKEN_SECRET` 显式设置** 为随机长字符串，避免重启踢掉全部登录态
3. **`data/*.db` 定时备份** — `sqlite3 youchou.db ".backup backup.db"`，或在 WAL 模式下直接复制 `.db`、`.db-wal`、`.db-shm` 三件套
4. **题源密钥换掉** `catalog.js` 里的 `sk_*_demo_secret`，每家单独生成并走密钥管理
5. **`npm run seed` 不要在生产执行** — 它会写演示数据；生产用 `seed({ reset: false, withHistory: false })` 或只跑建表
6. **HTTPS + 反向代理** — 用 Nginx/Caddy 终止 TLS，Node 只监听 127.0.0.1
7. **改掉演示密码，并强制首登改密** — `admin12345` / `demo123456` 只用于演示；生产建号后应让用户首次登录必须改密
8. **后台加 IP 白名单或二次验证** — 现在是「密码 + 角色」，没有 2FA；高价值操作建议加 TOTP 或短信验证
9. **提现走真实代付通道** — 现在是财务点「确认打款」直接落 `paid`，生产应改为调用代付 API，以渠道异步回调为准
10. **审计表归档** — `audit_logs` 只增不减，量大后按季度归档到冷存储，别让它拖慢主库
11. **合规**：问卷佣金模式在境内涉及个人信息收集与资金结算，需确认题源授权、用户告知同意、以及提现通道的资质要求

---

## 三端策略

后端 API 是唯一的业务真相，三端共用。

- **Web**：`public/app.html`（用户端）+ `public/console.html`（后台），已完整实现，真实调 API
- **小程序**：直接复用同一套 `/api/*`。需要改动的是：登录换 `wx.login` + `code2session`（在 `routes/auth.js` 增加一个 `POST /api/auth/wx`，用 openid 建号），提现换微信商家转账。前端用原生小程序或 Taro 重写视图层，业务逻辑不变
- **APP**：WebView 套壳或 RN/Flutter，同样复用 API。分包策略上，答题页建议原生实现（体验关键路径），其余页面可 WebView

三端共用一套佣金账本与风控，不做端侧分叉 —— 否则对账会失控。

---

## 已知边界

诚实标注当前实现的边界，避免误判为已完成：

**题源**

- 抓取是**真的**：`wjx` 适配器实抓问卷星公开列表，数据可核。但只有 1 个站点验证可用
- 其余 8 家（X / YouTube / Yahoo / Facebook / TikTok / Reddit / LinkedIn / Spotify）**还没接**。它们不是「抓一下就有」的：要么要 API key（X、YouTube、TikTok），要么强反爬/需登录（Facebook、LinkedIn），本机实测 Reddit 与 Yahoo RSS 直接不可达（连接被拒 / 403）
- 抓来的只是**元信息**（标题、链接），没有题目。要站内答题必须走 API 合作，拿官方题库
- 外部任务的佣金核销目前是「运营人工确认」。真人跑通的自动化核销需要题源 postback 支持
- 未做增量调度：没有内置定时抓取，靠手动按钮或外部 cron（`npm run crawl`）

**业务**

- 提现**未接真实代付通道**：财务点确认即落 `paid`，没有实际资金流。生产应调渠道 API 并以异步回调为准
- 设备指纹取 `device_id`，来自客户端上报，可伪造。生产应结合 IP、UA、Canvas 指纹服务端生成
- 无消息推送（短信/站内信），无客服工单
- 单机 SQLite，写并发上限约每秒数百。到量级后需迁 PostgreSQL，`db.js` 的 `tx()` 和仓储层是唯一改动点

**权限**

- 没有二次验证（2FA/TOTP）。密码泄露即失守，高价值后台建议补
- 没有 IP 白名单与异地登录告警。`login_attempts` 已记录 IP，接告警只是加个查询
- 权限点是代码里写死的矩阵，没有做成「自定义角色 + 界面勾选权限」。角色只有 4 个，够用，但不可运营配置
- 审计只覆盖后台与认证，前台用户侧（答题、提现申请）靠业务表本身留痕，没有统一进 `audit_logs`
- 会话表随登录次数增长，靠每小时清理超 30 天的过期记录控制；量大时应改为定期归档

---

## 一句话总结

**前端能点、后端能跑、数据能存、佣金能对、题源能抓、权限能挡、操作能查、测试能过。**

不是原型图，`npm start` 就能用的系统；`npm run crawl` 抓的是真实问卷；后台四个角色职责分离，动钱必有留痕。
