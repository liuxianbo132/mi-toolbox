# 开工简报 · M2（前端窗口，2026-11-21）

## 背景（自包含）

- M1 已关账（八条全绿，证据 docs/evidence/2026-11-21-m1-execution.md）。环境：`wbapp_r53cbHLLmYxU6r3LT4wbA6`，契约唯一权威 `docs/data-contract.md` **v1.7**。
- **后端 M2 已全部就绪，无新依赖**：`allergies` / `drug_allergy_links` / `medication_plans` / `medication_doses` 四表 + RLS（`household_id IN my_household_ids()`）+ pg_cron 漏服翻转（每 5 分钟，`mi-toolbox-miss-dose-flip`）均已落库并在跑。**无新 RPC**，前端直接用 SDK 做 CRUD（数据层沿用 `utils/data-access.js` 的 createTableAccess 模式，新表白名单须含 `id`——M1 的教训）。

## 已落库的表结构（写代码前先核对）

- `allergies`: id, member_id(bigint→members.id), household_id, allergen(text), created_at
- `drug_allergy_links`: id, household_id, item_id, allergen(text), kind('forbidden'|'caution'), created_at
- `medication_plans`: id, household_id, item_id, member_id, times(jsonb 时间点数组 如 ["08:00","20:00"]), freq('daily'|'alternate_day'), start_date, end_date, miss_threshold_minutes(int default 30), status('active'|'finished'|'cancelled'), created_at
- `medication_doses`: id, household_id, plan_id, scheduled_at(timestamptz), confirmed_at, status('pending'|'taken'|'missed'|'escalated'), created_at
- 漏服：cron 每 5 分钟把 `pending AND scheduled_at + miss_threshold_minutes < now()` 翻为 `missed`；**'escalated' 本期不使用**，missed 即升级态（红标）

## 任务（M2a → M2b 两步交付，分步验收）

### M2a 用药核心闭环

1. **tabBar 3→4**：新增「用药」tab（`pages/medication/`，app.json 注册）；现有三 tab 不动
2. **用药计划 CRUD**（入口放药品详情页 + 用药 tab 内新建）：选服药成员（members 列表）、时间点多个（HH:mm）、频次 daily/alternate_day、疗程起止（**≤180 天**）、阈值（**10~120 步进 5，默认 30**）
3. **doses 生成（契约 v1.7 #5/#6）**：保存计划时**一次性生成**整疗程 doses（daily=每天×时间点；alternate_day=start+2n 天×时间点）；`start_date` 早于今天的时间点**不生成**；计划变更 = **删除未发生 pending**（scheduled_at > now）后按新计划重建，已 taken/missed 保留；停用/取消（status='cancelled'）时同样删除未来 pending
4. **今日时间线**：doses 按 scheduled_at 排序展示（家庭成员全员，标注服药人昵称）；pending=待确认、taken=绿标、missed=**红标（升级态）**；点确认 → `confirmed_at=now, status='taken'`
5. **home 看板顶部提醒条**：今日存在 missed 剂量时显示「今日漏服 N 次」红条，点击跳用药 tab

### M2b 过敏与开封

6. **过敏档案**（入口放「我的」页家庭成员区）：本人可增删自己的过敏原；owner 可代管家庭成员（member_id 关联）
7. **药品过敏关联**：药品详情页（category=medicine）编辑 `drug_allergy_links`（allergen 文本 + kind forbidden/caution）
8. **冲突标红**：查看药品详情/用药计划时，当前用户 `allergies.allergen` ∩ 该药 `drug_allergy_links` → 命中 forbidden 红标「禁用」、caution 橙标「慎用」；展示范围=本人档案（不做全成员矩阵）
9. **标记开封**：物品详情页批次操作加「标记开封」按钮 → 写 `batches.opened_at=now`（开封分级 M1 已生效，此处只补入口）

## 红线

- 不改 M1 已验收行为（录入/详情/库存/看板/家庭管理/分级口径）；日期函数只用 `utils/date.js` 现有口径
- 不改 `utils/cloud.js`；不动 `sql/`
- 新表读写在 data-access.js 建 access 实例，白名单含 `id`；写路径字段必须与上面表结构一致（多余字段会被 pickFields 丢弃，缺 NOT NULL 字段会插入失败）
- 删除任何数据前必须弹确认；git push 先问用户

## 验收标准（M2a 先行）

1. 用药 tab 可建计划 → doses 生成条数正确：daily、3 天、08:00+20:00 = **6 条**；alternate_day、start 起 3 个日历日 = **2 条**（start、start+2）
2. 打卡后时间线状态翻转（pending→taken，绿标），confirmed_at 非空
3. 把某 plan 的 `miss_threshold_minutes` 改小 + 等 cron 一轮（≤5 分钟）→ 该 pending 变 missed，时间线红标；home 提醒条出现
4. 计划变更：改时间点保存 → 未来 pending 重建为新时间点，历史 taken/missed 不丢
5. M2b：过敏档案增删生效；药品关联 forbidden/caution 后，本人查看见红/橙标；标记开封后看板分级按 min(到期日, 开封到期日) 变化
6. 编译通过 + 自测一轮，回报总控（附改动清单与关键 DB 终态截图/说明）
