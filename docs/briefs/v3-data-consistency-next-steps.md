# V3 数据一致性后续收敛说明

> 状态：V3 发布后的治理设计，不代表已立项或已实施。
> 日期：2026-11-23
> 范围：只读审计、接口契约和迁移边界设计；本轮不执行 SQL、不修改数据库、不修改业务代码。
> 依据：`docs/data-contract.md`、`pages/inventory/inventory.js`、`pages/home/home.js`、`pages/medication/medication.js`、`sql/02-base-schema.sql`、`sql/03-m2-schema.sql`、`docs/briefs/v3-backend-risk-brief.md`、`docs/briefs/release-smoke-checklist.md`。

## 决策摘要

以下问题均不阻塞当前体验版放行；现有真机目视等发布门槛不受本文改变。

| 问题 | 优先级 | 当前影响 | 建议里程碑 |
|---|---|---|---|
| active batches 超过 3000 后聚合不完整 | P1 | 位置角标、位置筛选、最早到期排序可能只基于部分批次 | M3A：新增按物品汇总的只读 RPC |
| 首页今日 doses 最多读取 50 条 | P1 | 单日超过 50 次时总数少报 | M3A：exact count + 前 4 条预览 |
| `escalated` 未启用时的状态防护 | P2 | 未来出现该状态时，两页可能显示不一致 | M3A：统一状态映射，未知值不得回退为 pending |
| 跨家庭 `household_id` 关联不完整 | P1 | 模型层缺少同家庭复合约束；当前正常前端流程未发现实际越界证据 | M3B：先只读盘点，再裁决约束和迁移方案 |

## 1. active batches 超过 3000 的聚合

### 现状与失败边界

`pages/inventory/inventory.js` 每页读取 500 条 active batches，最多 3000 条，并多取一条判断是否超限。校验和截断逻辑本身正确，但超过 3000 条后：

- 物品位置角标只包含前 3000 条 active batches 中出现的位置；
- 位置筛选可能漏掉后续批次对应位置；
- “最早到期”排序使用的 `earliestExpiry` 可能缺失；
- 页面提示只能说明结果受限，不能恢复完整语义。

这是只读展示不完整，不会写坏批次数据。体验版继续保留现有提示；M3 不再扩展客户端批次分页循环。

### 推荐接口：按 item 汇总

建议新增只读 RPC：

```sql
public.inventory_active_batch_summary(
  p_household_id bigint,
  p_item_ids bigint[]
)
RETURNS TABLE (
  item_id bigint,
  active_batch_count bigint,
  earliest_expiry date,
  location_ids bigint[]
)
```

输入约束：

- `p_household_id` 必须显式传入，函数内部仍以 `batches.household_id = p_household_id` 隔离家庭；
- `p_item_ids` 为当前物品页的 ID 集合，当前上限 1000；
- 空数组返回空结果；超过 1000 个 ID 返回 `22023` 参数错误；
- 使用 `STABLE SECURITY INVOKER`，不绕过 RLS，也不授予 `anon`；
- 只读聚合，不创建缓存表、触发器或后台同步任务。

函数体可采用以下结构，部署前再按 SQL 留档规范放入独立迁移文件：

```sql
CREATE FUNCTION public.inventory_active_batch_summary(
  p_household_id bigint,
  p_item_ids bigint[]
)
RETURNS TABLE (
  item_id bigint,
  active_batch_count bigint,
  earliest_expiry date,
  location_ids bigint[]
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_item_ids IS NULL OR cardinality(p_item_ids) = 0 THEN
    RETURN;
  END IF;

  IF cardinality(p_item_ids) > 1000 THEN
    RAISE EXCEPTION 'too many item ids'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    b.item_id,
    count(*)::bigint AS active_batch_count,
    min(b.expiry_date) AS earliest_expiry,
    COALESCE(
      array_agg(DISTINCT b.location_id ORDER BY b.location_id)
        FILTER (WHERE b.location_id IS NOT NULL),
      ARRAY[]::bigint[]
    ) AS location_ids
  FROM public.batches b
  WHERE b.household_id = p_household_id
    AND b.status = 'active'
    AND b.item_id = ANY(p_item_ids)
  GROUP BY b.item_id;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_active_batch_summary(bigint, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_active_batch_summary(bigint, bigint[]) TO authenticated;
```

输出语义：

- 有 active batches 的物品返回一行；无 active batches 的物品不返回，由前端按 `activeBatchCount=0`、空位置、无最早到期处理；
- `location_ids` 是去重后的非空位置 ID，前端继续使用 `locations` 字典映射名称；
- `location_ids.length === 0` 显示“未指定”；
- `location_ids.length === 1` 显示对应位置名；
- `location_ids.length > 1` 显示“多位置”；
- `earliest_expiry` 直接用于“最早到期”排序。

### 分页替代比较

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 客户端继续分页读取全部 batches | 不改后端；结果可完整 | 请求次数和响应量随批次增长；仍受平台行数、超时和客户端 CPU 限制 | 不作为长期方案 |
| 按 item ID 调用聚合 RPC | 一次消除 3000 条上限；响应最多约 1000 行；不写数据库 | 依赖现有物品 1000 条上限 | M3A 推荐 |
| 服务端按 item cursor 分页返回“物品 + 聚合” | 同时解决物品和批次容量边界 | 接口和前端状态更复杂，需要处理跨页筛选 | 物品超过 1000 时再考虑 |
| 建立汇总表或触发器 | 读取最快 | 引入写放大和持续一致性责任，当前规模不值得 | 不采用 |

迁移边界：

- 本 RPC 不要求表结构变更，也不处理历史批次；
- 首个版本只移除 batches 3000 条聚合上限，不改变物品 1000 条上限；
- 部署顺序为先建只读函数、在隔离家庭夹具验证、再切换客户端；切换前保留旧路径作为回退；
- 若未来启用 item cursor 分页，应另行定义游标 `(created_at, id)`，不要继续按 batches 翻页。

验收夹具：

- active batches 数量为 2999、3000、3001、5000 时汇总完整；
- 同一物品有 0、1、2 个不同位置，结果分别对应未指定、单位置、多位置；
- 同物品的 used/discarded 批次不进入数量、位置和最早到期；
- 位置 ID 为空时不影响 `earliest_expiry`；
- 传入其他家庭 item ID 时不返回该物品的跨家庭批次；
- 返回行数不超过输入物品数，且输入超过 1000 时返回参数错误。

## 2. 首页今日 doses 总数少报

### 现状

`pages/home/home.js` 先读取当天最多 50 条 doses，再用数组长度作为 `todayDoseTotal`：`todayDoseTotal = list.length`。单日超过 50 次时，首页总数固定在 50；这不影响状态枚举判定，但会让用户误以为总数正确。

### 推荐实现

使用两个同条件查询：

1. `count=exact, head=true` 获取当天实际总数；
2. 普通查询按 `scheduled_at ASC` 取前 4 条用于摘要。

建议查询形状：

```js
const rangeFilters = (query) => query
  .eq('household_id', hid)
  .gte('scheduled_at', start.toISOString())
  .lt('scheduled_at', end.toISOString())

const countRes = await rangeFilters(
  cloud.database
    .from('medication_doses')
    .select('id', { count: 'exact', head: true })
)

const previewRes = await rangeFilters(
  cloud.database
    .from('medication_doses')
    .select('id, plan_id, scheduled_at, status')
    .order('scheduled_at', { ascending: true })
    .limit(4)
)
```

行为要求：

- `todayDoseTotal` 只使用 `countRes.count`，不得再由数组长度代替；
- 任一查询失败都进入 `medicationSummaryState=error`，不得展示少报的局部总数；
- 4 条预览和 count 使用完全相同的家庭、日期区间条件；
- count 与预览是两个请求，极端并发下可能对应相邻瞬间；首页汇总可接受该弱一致，若要求同一快照再改单 RPC。

### count 与分页比较

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| count + 前 4 条 | 传输量小；总数准确；前端改动小 | 两次请求；计数依赖索引性能 | M3A 推荐 |
| 分页读取全部 doses | 可同时得到完整列表 | 为首页总数读取最多数十至数百行，不必要 | 不采用 |
| 单 RPC 返回 count 和预览 | 同一语句快照；一次网络请求 | 需要新增后端接口和契约 | 对强一致有要求时再升级 |

索引边界：

- 现有 `(status, scheduled_at)` 适合带状态条件的扫描，但不优先生效于“家庭 + 日期”的 count；
- M3A 可评估新增 `(household_id, scheduled_at)` 索引；
- 加索引前必须结合生产行数和 `EXPLAIN` 结果，不因本设计文档直接执行 DDL。

验收夹具：

- 当天 0、1、4、5、50、51 条 doses；
- 页面总数分别为 0、1、4、5、50、51，且 only 4 条进入预览；
- count 成功、预览失败时显示错误，不显示 4 或其他局部总数；
- 日期区间边界不包含次日 00:00，不遗漏当天 00:00。

## 3. `escalated` 与未知状态防护

### 现状

- `pages/home/home.js` 使用 `DOSE_TAG[d.status] || DOSE_TAG.pending`，未知状态会被误标成“待服”；
- `pages/medication/medication.js` 对未知状态显示原始值，但状态样式回落到 amber；
- 契约当前只启用 `pending/taken/missed`，`escalated` 本期不使用，因此这是潜在风险，不是当前体验版阻塞。

### 统一映射

M3A 提取共享只读映射，两页只消费映射结果，禁止各自写 fallback：

| 原始 status | 展示文案 | 样式 | 可确认 | 计入 pending |
|---|---|---|---|---|
| `pending` | 待服药 | amber | 是 | 是 |
| `taken` | 已服药 | green | 否 | 否 |
| `missed` | 漏服 | red | 否 | 否 |
| `escalated` | 已升级 | red | 否 | 否 |
| 未知值 | 状态异常 | neutral/red | 否 | 否 |

关键规则：

- 只有 `pending` 可以显示打卡入口；
- 未知状态不得回退为 `pending`，也不得当作 `taken` 或 `missed`；
- `escalated` 未正式启用前，如果意外出现，应显示“已升级”或“状态异常”并保留原始值日志，不能静默变成待服；
- 首页是否将 `escalated` 计入漏服红条必须另行裁决；在契约未启用前默认只统计 `missed`；
- 两页可以使用不同短文案，但标签语义、样式、可确认性和计数口径必须来自同一映射。

验收用例：

- 对 `pending/taken/missed/escalated/null/unknown` 六个输入分别验证两页输出；
- `escalated` 和未知值均不可打卡；
- 首页漏服数不因未知值增加，也不因未知值显示成“待服”；
- 以后启用 `escalated` 时，只需修改共享映射和契约，不在页面逐一修补。

## 4. 跨家庭关联完整性只读盘点

### 检查关系

| 子表.字段 | 父表 | 当前约束 | 盘点口径 |
|---|---|---|---|
| `batches.item_id` | `items.id` | 单列 FK | 家庭必须一致 |
| `batches.location_id` | `locations.id` | 无 FK，可空 | 非空时必须同家庭；悬空 ID 单独统计 |
| `records.batch_id` | `batches.id` | 无 FK，可空 | 非空时必须同家庭；历史悬空是否豁免需裁决 |
| `allergies.member_id` | `members.id` | 单列 FK | 家庭必须一致 |
| `drug_allergy_links.item_id` | `items.id` | 单列 FK | 家庭必须一致 |
| `medication_plans.item_id` | `items.id` | 单列 FK | 家庭必须一致 |
| `medication_plans.member_id` | `members.id` | 单列 FK | 家庭必须一致 |
| `medication_doses.plan_id` | `medication_plans.id` | 单列 FK | 家庭必须一致 |

这些是现有 RLS 无法完全替代的跨行约束。RLS 只判断当前行能否被访问，普通 FK 只判断目标行是否存在，两者都不保证父子行属于同一家庭。

### 只读汇总 SQL

以下 SQL 只执行 `SELECT`，并用只读事务包住。必须在确认生产应用 `wbapp_r53cbHLLmYxU6r3LT4wbA6` 后，由具备完整读取权限的受控连接执行；普通成员会话受 RLS 过滤，不能作为全量盘点证据。

```sql
BEGIN TRANSACTION READ ONLY;

WITH cross_family AS (
  SELECT 'batches.item_id' AS relation, count(*)::bigint AS violation_count
  FROM public.batches c
  JOIN public.items p ON p.id = c.item_id
  WHERE c.household_id <> p.household_id

  UNION ALL

  SELECT 'batches.location_id', count(*)::bigint
  FROM public.batches c
  JOIN public.locations p ON p.id = c.location_id
  WHERE c.household_id <> p.household_id

  UNION ALL

  SELECT 'records.batch_id', count(*)::bigint
  FROM public.records c
  JOIN public.batches p ON p.id = c.batch_id
  WHERE c.household_id <> p.household_id

  UNION ALL

  SELECT 'allergies.member_id', count(*)::bigint
  FROM public.allergies c
  JOIN public.members p ON p.id = c.member_id
  WHERE c.household_id <> p.household_id

  UNION ALL

  SELECT 'drug_allergy_links.item_id', count(*)::bigint
  FROM public.drug_allergy_links c
  JOIN public.items p ON p.id = c.item_id
  WHERE c.household_id <> p.household_id

  UNION ALL

  SELECT 'medication_plans.item_id', count(*)::bigint
  FROM public.medication_plans c
  JOIN public.items p ON p.id = c.item_id
  WHERE c.household_id <> p.household_id

  UNION ALL

  SELECT 'medication_plans.member_id', count(*)::bigint
  FROM public.medication_plans c
  JOIN public.members p ON p.id = c.member_id
  WHERE c.household_id <> p.household_id

  UNION ALL

  SELECT 'medication_doses.plan_id', count(*)::bigint
  FROM public.medication_doses c
  JOIN public.medication_plans p ON p.id = c.plan_id
  WHERE c.household_id <> p.household_id
),
dangling_refs AS (
  SELECT 'batches.location_id' AS relation, count(*)::bigint AS violation_count
  FROM public.batches c
  LEFT JOIN public.locations p ON p.id = c.location_id
  WHERE c.location_id IS NOT NULL
    AND p.id IS NULL

  UNION ALL

  SELECT 'records.batch_id', count(*)::bigint
  FROM public.records c
  LEFT JOIN public.batches p ON p.id = c.batch_id
  WHERE c.batch_id IS NOT NULL
    AND p.id IS NULL
)
SELECT 'cross_family' AS check_kind, relation, violation_count
FROM cross_family
UNION ALL
SELECT 'dangling_reference' AS check_kind, relation, violation_count
FROM dangling_refs
ORDER BY check_kind, relation;

ROLLBACK;
```

若某项计数不为零，再按同一 JOIN 条件输出 `child_id`、`child_household_id`、`parent_id`、`parent_household_id`，每次 `LIMIT 50`，不导出物品名、昵称或备注。样例只能用于确认异常形态，不能替代全量计数。

结果处置：

- 所有 cross-family 命中默认视为缺陷，需要形成按关系分类的样例与修复方案；
- `batches.location_id` 悬空和 `records.batch_id` 悬空先按契约判定是否为可接受历史状态，不得直接当跨家庭违规；
- 只要存在未豁免的 cross-family 行，就不建立对应复合唯一键或复合 FK；
- 约束上线前必须确定删除行为，不能用本盘点自动决定 cascade、set null 或历史保留策略。

### 约束进入条件

1. 只读盘点记录执行时间、数据库身份、角色和完整计数；
2. 产品确认每类关系必须同家庭，并明确位置删除后 `location_id` 置空、流水留存等例外；
3. 异常行归零或取得逐类书面豁免；
4. 在非生产环境验证合法同家庭写入、非法跨家庭写入被拒、既有 CRUD 和家庭成员变更不回归；
5. 准备回滚路径后才讨论生产约束迁移。

## 5. 里程碑与放行判断

### 不阻塞当前体验版

- batches 超过 3000 只影响极端容量下的展示完整性，当前已有明确提示；
- 首页超过 50 次是低频统计少报，不影响剂量本身状态；
- `escalated` 当前未启用，且现有路径不会主动写入；
- 跨家庭关联尚无真实异常证据，正常前端路径均使用当前家庭 ID。

因此本文不改变 `release-smoke-checklist.md` 第 37 行的放行结论，也不替代现有真机目视门槛。

### M3A：只读能力与展示一致性

- 新增 active batches 汇总 RPC，替换客户端 3000 条聚合上限；
- 首页改为 exact count + 前 4 条预览；
- 建共享 doses 状态映射，未知值禁止回退为 pending；
- 评估并验证 `(household_id, scheduled_at)` 索引；
- 不改跨表约束，不处理历史异常数据。

### M3B：关联完整性治理

- 执行生产只读盘点并形成异常清单；
- 产品裁决每类父子关系的同家庭规则和删除语义；
- 对无异常或已豁免的关系设计 `(household_id, id)` 唯一键与复合 FK；
- 在非生产完成迁移、非法写入和回滚验证后，才批准生产 DDL；
- 一人一家庭并发竞态继续按 `v3-backend-risk-brief.md` 单独处理，不与本次三项读取问题捆绑。

## 完成标准

- M3A 的 3001/5000 active batches 夹具结果与数据库聚合一致，位置角标和最早到期不再受 3000 上限影响；
- 当天 51 条 doses 时首页显示 51，预览仍为前 4 条；
- `escalated`、未知值和空状态在两页显示一致，均不可误确认；
- M3B 盘点 SQL 全程只读，输出按关系计数且零异常或例外获批；
- 未经单独授权，不执行 DDL、不更新真实家庭数据、不 commit/push。
