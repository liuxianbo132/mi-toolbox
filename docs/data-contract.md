# 小咪工具箱 · 数据契约 v2.0

> 本文件是前端/后端/测试三个窗口的唯一对齐依据。字段命名冲突、结构变更，一律回总控窗口裁决后更新此文件并递增版本号。
> **v1.1 变更（2026-11-19，后端窗口校对回写）**：「现有表」整节按实际库重写——补录契约漏掉的 `locations`、`records` 两张表与各表缺失字段；`members` 时间字段实为 `joined_at`（v1 写 `created_at` 是笔误）；补录 RLS 实况与辅助函数。「新增表 / 常量 / 推送链路」三节未动。
> **v1.2 变更（2026-11-19，总控裁决 R1/R2）**：①到期日换算改为「生产当天计第 1 天」(+N−1)，开封后有效期同口径；②一人一家庭——join_household 行为变更（already_joined），新增 create_household / leave_household / remove_member 三个 RPC 约定；③locations / records 两表 V1 前端不接 UI。
> **v1.3 变更（2026-11-19，总控裁决 R3，依据后端实测）**：①「服务端推送不可行」坐实 → 通知主链路 = 打开小程序惰性计算 + 看板红点/汇总；②reminder_log 延后，M1/M2 均不建；③M2 漏服判定落库方案 = pg_cron 库内翻转 doses 状态；'escalated' 本期不使用。
> **v1.4 变更（2026-11-19，总控验收，确认后端裁量）**：①create_household / leave_household / remove_member 返回值补 'not_signed_in' 兜底；②create_household 的 owner 成员 nickname 不落库，前端以 session 用户名兜底显示；③空家庭名由 RPC RAISE EXCEPTION 拦截（与前端校验双保险）。**云端落库已验收**（总控实查：items.visibility 列在库、4 个 RPC 函数在库，2026-11-19）。
> **v1.5 变更（2026-11-19，总控裁决 R5，清空 test-plan §6 的 M1 级待裁决项）**：①expired 分级补录常量（<0 → expired）；②**#13 开封后到期日参与临期分级**（有 opened_at 的批次按 min(到期日, 开封到期日) 分级，「标记开封」UI 入口属 M2，M1-07 以 exec_sql 构造 opened_at 断言）；③#3 批次数量编辑必须 >0，清零用「用完」；④#4 库存列表为物品维度，历史批次在详情页展示。
> **v1.6 变更（2026-11-20，环境身份收敛，总控批准 R6）**：双应用错位修复——生产应用切换为 **wbapp_r53cbHLLmYxU6r3LT4wbA6**（已绑定小程序 + 云服务已开通），`utils/cloud.js` publicConfig 三值随之更换；**wbapp_mCzPMhf3up1PsJr96aYq59 冻结为存档**（勿删勿改，仅作 schema/RPC 权威参照）。新增「环境身份」节；SQL 留档纪律升级：基础 schema 必须补录 02-base-schema.sql。
> **v1.7 变更（2026-11-20，总控裁决 R7 · M2 裁决包）**：①#14 cron 周期定档 5 分钟（判定延迟上界 = 阈值 + 5 分钟）；②#5 doses 整疗程一次性生成（保存计划时即时生成），疗程上限 180 天；③#6 计划变更 = 删未发生 pending doses 重建，历史 taken/missed 保留，start_date 早于今天不补历史；④#9 alternate_day = start_date + 2n 日历日，非服药日不生成；⑤#10 miss_threshold_minutes 前端限 10~120（步进 5）默认 30，DB 无 CHECK。
> **v1.8 变更（2026-11-21，V2 方案定稿）**：新增「V2 约定」节——records.action 四类枚举与静默失败语义、locations 使用口径与删除置空、barcode 扫码匹配规则、库存按品类分组与位置角标规则。
> **v2.0 变更（2026-11-23，回收站立项 · 软删除）**：`items` / `batches` 新增 `is_deleted boolean NOT NULL DEFAULT false` 与 `deleted_at timestamptz`（`sql/06-soft-delete.sql`）。删除操作一律软删（`is_deleted=true` + `deleted_at=now`）；**所有用户可见读取必须 `.eq('is_deleted', false)`**；回收站页（`pages/trash`）可恢复（仅写 `is_deleted=false`）或彻底删除（物理 DELETE，二次确认）。例外：`records` 与 `locations` 不参与软删；历史名称映射类查询（依从性页、首页今日用药、用药页的 items 名映射）**不过滤**，保证已删药品的历史显示；数据导出包含已删数据（备份完整性）。`ITEM_FIELDS` / `BATCH_FIELDS` 白名单包含 `is_deleted` / `deleted_at`。

## 环境身份（v1.6）

- **生产应用**：`wbapp_r53cbHLLmYxU6r3LT4wbA6`（已绑定小程序 + 云服务已开通）。`utils/cloud.js` publicConfig 指向它（publishableKey `wbpk_r53cb…`、OAuthClientId `cb_…_wbapp_r53cb…`、endpoint 不变），具体值以 `utils/cloud.js` 为准
- **冻结存档**：`wbapp_mCzPMhf3up1PsJr96aYq59`——总控裁决 R6：原样保留，不 DROP、不改动、不跑写操作；其 6 表结构 / RLS 策略 / RPC 函数为新环境重建的权威参照
- **留档纪律（v1.6 升级）**：所有 schema / 函数 / RLS 变更必须落 `sql/*.sql`（幂等可重跑）；基础 6 表 + `my_household_ids()` + RLS 策略补录为 `sql/02-base-schema.sql`（后端窗口从旧环境导出生成）
- 三份 briefs 中所有指向旧应用 ID 的描述作废，以本节为准

## 通用约定

- 表名/字段名 snake_case；主键 `id`（**实际为 bigint**）；外键 `household_id` / `item_id` / `member_id` / `plan_id`
- 时间列默认 `timestamptz NOT NULL default now()`（例外：`members` 叫 `joined_at`）
- 枚举值（category / status / role / kind 等）**库内无 CHECK 约束**，为应用层约定，测试与前端按下文集合校验
- RLS 原则：所有业务表按「当前登录用户所属 household」隔离（实况见下，辅助函数 `my_household_ids()`）
- 可见性预留：`items.visibility text default 'household'`（预留 `'public'` 扩展，V1 不做公开读写）

## 现有表（2026-11-19 后端窗口按实际库校对，以下为真实结构）

- `households`: id(bigint PK), owner_id(text NOT NULL default auth.uid() 家庭创建者), name(text NOT NULL), invite_code(text NOT NULL UNIQUE), created_at
- `members`: id(bigint PK), household_id(bigint NOT NULL FK→households ON DELETE CASCADE), owner_id(text NOT NULL default auth.uid()), role(text NOT NULL default 'member'，约定 'owner'|'member'), nickname(text NULL，v1.9 起为家庭内昵称，本人可设置/修改), **joined_at**(timestamptz NOT NULL default now()，**v1 写 created_at 是笔误，以 joined_at 为准**)
  - UNIQUE (household_id, owner_id) —— 防重复加入；索引 idx_members_owner(owner_id)
- `items`: id(bigint PK), household_id(bigint NOT NULL), name(text NOT NULL), barcode(text NULL), category(text NOT NULL default 'food'，约定 food/medicine/daily/other), brand(text NULL), spec(text NULL), unit(text NULL default '件'), shelf_life_days(int NULL), pao_days(int NULL), low_stock_threshold(int NULL), remark(text NULL), created_at
  - 索引 idx_items_household(household_id)
- `batches`: id(bigint PK), household_id(bigint NOT NULL), item_id(bigint NOT NULL FK→items), production_date(date NULL), expiry_date(date NOT NULL), quantity(numeric NOT NULL default 1), unit(text NULL), location_id(bigint NULL 软关联 locations 无 FK), status(text NOT NULL default 'active'，约定 active/used/discarded), opened_at(timestamptz NULL 开封时间), price(numeric NULL), source(text NULL 录入来源), owner_id(text NOT NULL default auth.uid() 录入人), owner_name(text NULL 录入人昵称快照), created_at
  - 索引 idx_batches_household_expiry(household_id, expiry_date)（临期看板主查询路径）、idx_batches_item(item_id)
- `locations`（v1 漏录）: id(bigint PK), household_id(bigint NOT NULL), name(text NOT NULL), kind(text NULL default 'pantry'), created_at
  - 索引 idx_locations_household(household_id)
- `records`（v1 漏录，操作流水）: id(bigint PK), household_id(bigint NOT NULL), batch_id(bigint NULL), action(text NOT NULL), quantity(numeric NULL), note(text NULL), owner_id(text NOT NULL default auth.uid()), owner_name(text NULL), created_at
  - 索引 idx_records_household(household_id)

### RPC / 函数

- `join_household(p_code text)` → text：`'not_signed_in' | 'not_found' | 'ok' | 'already_joined'`（**v1.2 行为变更**：调用者已有任一家庭时返回 'already_joined'，取代 v1.1 的「重复加入 ON CONFLICT DO NOTHING 返回 'ok'」；一人一家庭在 RPC 层强制）
- `create_household(p_name text)`（v1.2 新增，M1）→ text：`'ok' | 'already_joined' | 'not_signed_in'`；SECURITY DEFINER 原子创建 households + owner 成员记录，invite_code 由服务端生成（沿用 HB+6 位格式），替代前端「两段直接插入」的旧写法；owner 成员 nickname 不落库（v1.4 裁量确认），前端以 session 用户名兜底显示
- `leave_household()`（v1.2 新增，M1）→ text：`'ok' | 'owner_cannot_leave' | 'not_signed_in' | 'not_found'`；仅 role='member' 可调用，删除自身成员记录后回「创建/加入」流
- `remove_member(p_member_id bigint)`（v1.2 新增，M1）→ text：`'ok' | 'forbidden' | 'not_found' | 'not_signed_in'`；仅本家庭 owner 可调用，目标须为 role='member'
- `my_household_ids()` → SETOF bigint：RLS 辅助函数，返回当前用户所属全部 household_id（下述 RLS 均依赖它）

### 成员关系变更语义（v1.2 · R2 裁决）

- **一人一家庭**：V1 锁定。前端在已加入家庭后隐藏「创建/加入」入口；`UNIQUE(household_id, owner_id)` 只防同家重复，跨家重复由 join/create 两个 RPC 判断拦截
- **member 退出**：删除自身 members 记录；退出后按 RLS 自动失去该家庭全部数据可见性；物品属于家庭，不迁移不带走
- **owner 移除成员**：仅限本家庭 role='member' 的目标；被移除者可见性同上
- **owner 不可退出/解散**：V1 不做（级联删除是独立产品题）；前端对 owner 隐藏退出入口，误加死胡同由「退出/移除」两个能力关闭

### 昵称约定（v1.9）

- `members.nickname` 为家庭内昵称，**本人可设置/修改**（members RLS 允许本人 UPDATE 自己那一行，WITH CHECK `owner_id = auth.uid()`，无需数据库变更）
- `records.owner_name` 与 `batches.owner_name` 在**写入时快照当时昵称**（优先取 `members.nickname`；未设置时回退 session 用户名；仍为空则省略该字段）
- **历史记录不回溯**：修改昵称只影响之后新写入的流水与批次，已落库的 owner_name 保持原值

### RLS 实况（6 表全部启用 relrowsecurity）

- `households`：4 条策略——select 本人或 household 成员可见；insert/update/delete 仅 `owner_id = auth.uid()`
- 其余 5 表（members / items / batches / locations / records）：各 1 条 ALL 策略，`using/with check = household_id IN (SELECT my_household_ids())`；members 额外放行 `owner_id = auth.uid()`（with check 仍限 owner_id = auth.uid()）

- 可见性预留：`items.visibility text NOT NULL default 'household'`（**已落库 2026-11-19 后端窗口**，见 `sql/01-rpc-household.sql`；预留 `'public'` 扩展，V1 不做公开读写、RLS 不变）

## 新增表（按里程碑落库，M1 只建 2 项，M2 建 4 项）

### M1
- `items` 加列 `visibility text default 'household'`
- （v1.3）`reminder_log` 延后：服务端推送通道不可行（见「通知链路」节），M1/M2 均不建，待通道恢复再落库

### M2
- `allergies`: id, member_id, household_id, allergen(text 过敏原名), created_at
- `drug_allergy_links`: id, household_id, item_id, allergen(text), kind('forbidden'|'caution'), created_at
  （设计说明：过敏原暂用文本精确匹配比对 = links.allergen ∩ member.allergies；若后端窗口认为应规范化为字典表，提方案回总控裁决）
- `medication_plans`: id, household_id, item_id, member_id, times(jsonb 时间点数组，如 ["08:00","20:00"]), freq('daily'|'alternate_day'), start_date, end_date, miss_threshold_minutes(int default 30), status('active'|'finished'|'cancelled'), created_at
- `medication_doses`: id, household_id, plan_id, scheduled_at(timestamptz), confirmed_at, status('pending'|'taken'|'missed'|'escalated'), created_at
  - （v1.3）漏服判定落库：pg_cron 定时任务 `UPDATE medication_doses SET status='missed' WHERE status='pending' AND scheduled_at + (miss_threshold_minutes * interval '1 minute') < now()`（UPDATE 天然幂等）；'escalated' 本期不使用，升级呈现 = 看板红标，不发微信消息

## V2 约定（v1.8）

- **操作流水 `records`**：action 枚举 `'create' | 'open' | 'use_up' | 'discard'`（入库/开封/用完/报废）；主操作成功后写入（batch_id、quantity、物品名快照、owner 快照），**写失败静默、不阻塞主操作**；查看页按 created_at 倒序
- **存放位置 `locations`**：V2 只用 `name`（kind 保留表默认 `'pantry'`，不做分类展示/筛选）；批次挂 `batches.location_id`（可选，未选 = 未指定）；**删除位置后，该家庭内相关批次的 location_id 置空**（前端先置空再删，或删后按「未指定」展示）
- **条码 `items.barcode`**：扫码匹配限同 household 内，不加唯一约束；多命中取最近创建；扫码仅真机可用（开发者工具模拟器不支持 scanCode）
- **库存展示**：按品类分组（food / medicine / daily / other，组头带计数）；位置角标取该物品 active 批次的位置，多位置显示「多位置」、无位置显示「未指定」

## 软删除约定（v2.0）

- **字段**：`items.is_deleted` / `batches.is_deleted`（boolean 默认 false）+ `deleted_at`（timestamptz，仅用于展示删除时间）
- **读取**：所有用户可见查询必须 `.eq('is_deleted', false)`；回收站页查询 `is_deleted = true`
- **删除**：一律软删（`is_deleted = true` + `deleted_at = now`）；彻底删除只在回收站内二次确认后物理 DELETE
- **恢复**：只写 `is_deleted = false`——`deleted_at` 残留旧值不参与任何判断（SDK 会丢弃 null，不可用置空策略）
- **例外**：`records` / `locations` 不参与软删；依从性页、首页今日用药、用药页的 items 名称映射**不过滤**（保证已删药品的历史显示）；数据导出包含已删数据（备份完整性）

## 常量（前后端共用，测试据此写用例）

- 临期阈值：medicine danger≤7 天 warn≤90 天；其他品类 danger≤3 warn≤7
- 临期分级（v1.5 补录）：daysUntil < 0 → 'expired'，否则 ≤danger → 'danger'，≤warn → 'warn'，其余 'ok'
- **开封后分级（v1.5 · #13）**：批次有 opened_at 时，实际到期日 = **min(expiry_date, calcOpenedExpiry(opened_at, items.pao_days))**，临期分级与看板排序均按实际到期日；「标记开封」UI 入口属 M2，M1-07 以 exec_sql 构造 opened_at 断言
- 漏服判定：`scheduled_at + miss_threshold_minutes` 未确认 → missed，触发 escalation
- 漏服扫描周期（v1.7 · #14）：pg_cron 每 5 分钟一轮；判定延迟上界 = 阈值 + 5 分钟
- 阈值范围（v1.7 · #10）：miss_threshold_minutes 前端限 10~120（步进 5），默认 30；DB 无 CHECK，应用层约定
- alternate_day 定义（v1.7 · #9）：服药日 = start_date + 2n 天（日历日间隔 2 天），非服药日不生成 doses
- doses 生成时机（v1.7 · #5/#6）：整疗程**一次性生成**（保存计划时即时生成）；start_date 早于今天的时间点不生成（不补历史漏服）；疗程上限 180 天（前端限制）；计划变更 = 删除未发生的 pending doses（scheduled_at > 变更时刻）并按新计划重建，已发生的 taken/missed 保留不动；阈值修改只影响未来判定，不追溯
- 品类集合：food / medicine / daily / other
- 批次数量（v1.5 · #3）：录入与编辑均须 >0；清零语义 = 「用完」（status='used'）
- 库存展示（v1.5 · #4）：库存列表为物品维度，不展示非 active 批次；已用完/报废批次在物品详情页「历史记录」区展示
- 到期日换算（v1.2 修订）：**到期日 = 生产日期 + N − 1 天，生产当天计第 1 天**（国内包装惯例；`calcExpiry` 相应调整）；开封后有效期 `calcOpenedExpiry` 同口径（开封当天计第 1 天）。录入页同时允许直接填到期日（包装印「保质期至 X 日」时免换算）

## 通知链路（v1.3 依后端实测重写）

- **实测结论（后端窗口 2026-11-19，skill 文档 + MCP 工具清单 + 官方文档三重确认，pg_cron 实测）**：WorkBuddy 云服务应用模型无云函数 / 后台任务 / 服务端出网通道——**微信订阅消息的服务端发送整体不可行**；数据库级 pg_cron 1.6 可用（仅限库内 SQL 任务，详见 sql/00-extensions.sql）
- **主链路（V1/M2 生效）**：打开小程序惰性计算 + 看板红点/汇总兜底；临期分级与漏服升级均以此呈现
- **订阅消息**：模板 id 不再申请；`subscribe.js` 埋点保留为占位（模板 id 为空时静默无副作用），通道恢复时启用
- **M2 漏服判定**：pg_cron 库内翻转 doses 状态（见 M2 节），升级通知以看板红标呈现，不发微信消息
