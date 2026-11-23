# 运维清单：pg_cron 漏服翻转任务的可观测性（2026-11-23）

> 状态：**只读巡检清单**。本文档不新增告警、不改 cron 表达式、不写任何业务数据，全部 SQL 标注**只读**。
> 依据：`sql/04-cron-jobs.sql`、`docs/briefs/v3-backend-risk-brief.md`（漏服 cron 复核节与只读验证步骤）、`docs/briefs/release-smoke-checklist.md`。
> 适用范围：目标库为生产应用 `wbapp_r53cbHLLmYxU6r3LT4wbA6` 对应的数据库；执行前先确认连接的不是冻结存档环境。

## 结论先行

| 项 | 结论 |
|---|---|
| 当前可观测性 | **只有事后留痕**：`cron.job_run_details` 记录每次运行，但没有主动告警；任务停止或报错，直到用户反馈才会被发现 |
| 判定口径 | 「健康」= job 存在 + `active=true` + 最近一次 `succeeded` 距今 ≤ 15 分钟（3 个调度周期） |
| 巡检成本 | 三条只读 SQL，单次约 10 秒，无需写权限 |
| 必查时点 | 发布前（每次涉及 M2/剂量/cron 的变更）、每月一次、用户反馈「漏服红条不出现」时立即三查 |
| 本文不做 | 不加推送告警（无服务端通道）、不改 `*/5 * * * *`、不手动 `UPDATE` 剂量状态 |

## 1. 现状

### 1.1 任务定义（`sql/04-cron-jobs.sql:29-38`）

| 属性 | 值 |
|---|---|
| 任务名 | `mi-toolbox-miss-dose-flip` |
| 周期 | `*/5 * * * *`（每 5 分钟；最终周期属 test-plan §6 #14 待裁决项） |
| 判定谓词 | `d.status='pending'` 且 `d.scheduled_at + p.miss_threshold_minutes * interval '1 minute' < now()`，JOIN `medication_plans` 取阈值 |
| 动作 | `UPDATE medication_doses SET status='missed'`（单条语句，无分批、无日志表） |
| 执行身份 | schedule 调用者（migrate 管理角色，表 owner），`relforcerowsecurity=false`，绕 RLS |
| 幂等 | 同名 `cron.schedule` 为 upsert，重跑不产生重复任务；**不要**用 `cron.unschedule` 预清理（任务不存在时抛 `XX000`） |

### 1.2 失败时的可见性缺口

| 情况 | 现场痕迹 | 谁会知道 |
|---|---|---|
| 任务被删除 / `active=false` | 无运行记录，`cron.job` 里查得到 | 没人，直到用户反馈 |
| 运行报错（权限、列不存在、超时） | `cron.job_run_details.status='failed'` + `return_message` | 没人主动看 |
| 运行成功但 0 行更新 | 返回 `UPDATE 0`，看不出异常 | 没人——这是最容易被误判为正常的情况 |
| 跨环境错配（job 在别的库） | 应用库的 `cron.job` 为空 | 没人 |

`cron.job_run_details` 是有保留期的，长期不查等于没有证据；因此巡检必须在「留痕被冲掉之前」发生。

## 2. 巡检清单（三查，全部只读）

### 2.1 第一查：任务是否存在且启用

```sql
-- 只读
SELECT jobid, jobname, schedule, active, database, username
FROM cron.job
WHERE jobname = 'mi-toolbox-miss-dose-flip';
```

判读：**0 行** = job 不存在（或连错库，见 3.1）；`active=false` = 被停用；`database` 必须与小程序当前云应用库一致。

### 2.2 第二查：最近 3 次运行的终态

```sql
-- 只读
SELECT runid, status, start_time, end_time,
       (end_time - start_time) AS duration,
       left(coalesce(return_message, ''), 300) AS return_message
FROM cron.job_run_details
WHERE jobid = (
  SELECT jobid FROM cron.job WHERE jobname = 'mi-toolbox-miss-dose-flip'
)
ORDER BY start_time DESC
LIMIT 3;
```

判读：`status` 应为 `succeeded`；`return_message` 形如 `UPDATE n`。出现 `failed` 时按 §3 第 3 行处置。

### 2.3 第三查：最近成功是否已过期（返回 boolean）

```sql
-- 只读：true = 最近一次成功距今超过 15 分钟（或从未成功/任务不存在），需介入
SELECT COALESCE(
         (SELECT max(start_time)
          FROM cron.job_run_details d
          WHERE d.jobid = (SELECT jobid FROM cron.job
                           WHERE jobname = 'mi-toolbox-miss-dose-flip')
            AND d.status = 'succeeded') < now() - interval '15 minutes',
         true
       ) AS success_is_stale;
```

为什么是 15 分钟：等于 3 个调度周期，允许 1 次抖动（时钟/连接/短时超时）而不误报，同时保证故障发现延迟不超过 15 分钟。若任务被删除或从未成功，子查询为 `NULL`，`COALESCE` 兜底为 `true`——**未知即视为异常**。

### 2.4 补充查：功能是否真的在生效（非 job 健康度）

```sql
-- 只读：返回 "该翻未翻" 的行数；正常应为 0
SELECT count(*) AS stuck_pending
FROM public.medication_doses d
JOIN public.medication_plans p ON p.id = d.plan_id
WHERE d.status = 'pending'
  AND d.scheduled_at + (p.miss_threshold_minutes * interval '1 minute') < now() - interval '10 minutes';
```

`- interval '10 minutes'` 是缓冲：只统计「超出阈值 10 分钟以上仍未翻转」的行，避免把刚好到期、等下一轮 cron 的正常行算成故障。

## 3. 判定与处置矩阵

| 观察到的现象 | 判定 | 处置（只读优先，变更另立单） |
|---|---|---|
| 2.1 返回 0 行 | job 不存在，或**连错数据库** | 先核 `current_database()` 与小程序云应用库是否同一；确认同库后仍缺失 → 属调度配置丢失，按发布流程重跑 `sql/04`（upsert 语义，不产生重复任务）。跨库时不要在原库补建 |
| 2.1 `active=false` | 被人工/控制台停用 | 查明停用人与时间；恢复需变更单，不在巡检中直接 `cron.alter_job` |
| 2.2 有 `failed` | 运行报错 | 按 `return_message` 分派：`42703`（列不存在，多为 schema 漂移/环境错配）→ 核对 `medication_plans.miss_threshold_minutes` 是否存在；`42501`（权限）→ 核对执行角色是否为表 owner；`57014`（取消/超时）→ 查锁等待与表体积；`42P01`（表不存在）→ 环境错配 |
| 2.2 全 `succeeded`，但 2.4 > 0 | 任务在跑但**没翻到位** | 按下面三条路径顺序排查 |
| 2.3 `false` 且 2.4 = 0 | 健康 | 记录一次即可 |
| 全部正常，用户仍反馈红条不出现 | 不在 cron 范畴 | 转前端/会话排查：页面是否重新拉取（`pages/medication/medication.js` `onShow`）、是否连错应用、是否检查时点早于阈值+cron 周期 |

### 3.1 「运行成功但 pending 未翻转」的三条排查路径

**路径一：数据库时钟**

```sql
-- 只读
SELECT now(), clock_timestamp(), current_setting('TimeZone');
```

`now()` 是事务开始时间，cron 的每条语句各自独立事务，二者差异通常秒级；若与真实时间偏差达到分钟级，则谓词判定窗口整体偏移。

**路径二：时区 / 写入时刻偏移**

`medication_doses.scheduled_at` 为 `timestamptz`，比较按绝对时间轴进行，数据库 `TimeZone` 只影响显示。但若客户端把本地时间当 UTC 序列化（或反之），写入的绝对时刻会整体偏移 8 小时——阈值 10 分钟的计划会「看起来永远未到期」。验证方式：

```sql
-- 只读：以一条已知探针剂量代入 id
SELECT d.id, d.status, d.scheduled_at,
       p.miss_threshold_minutes,
       d.scheduled_at + p.miss_threshold_minutes * interval '1 minute' AS due_at,
       now() > d.scheduled_at + p.miss_threshold_minutes * interval '1 minute' AS overdue
FROM public.medication_doses d
JOIN public.medication_plans p ON p.id = d.plan_id
WHERE d.id = <probe_dose_id>;
```

`overdue=false` 而业务上早该到期 → 属于写入时刻偏移（时区问题）；`overdue=true` 却仍 `pending` 且 job 成功 → 进入路径三。

**路径三：剂量行 / 计划行状态**

| 检查 | 说明 |
|---|---|
| `d.plan_id` 是否存在对应 plan | 孤儿剂量不会被 JOIN 命中，永远不会被翻转 |
| `p.miss_threshold_minutes` 是否被改成很大的值 | 阈值调大后「未到期」是正确行为，不是故障 |
| `d.status` 是否已是 `taken` / `missed` | 已终态的行不参与翻转（`status='pending'` 过滤） |
| 是否存在长事务持锁 | `UPDATE` 被阻塞时 `job_run_details` 会长时间停在运行态或超时失败 |

## 4. 巡检节奏

| 时点 | 范围 | 记录 |
|---|---|---|
| **发布前必查**（涉及 M2 / 剂量 / cron / schema 的任何变更） | 2.1 + 2.2 + 2.3，外加一条探针剂量端到端（建未来剂量 → 过阈值 + 1 个周期 → 直读 DB 状态） | 附在发布 checklist，记 jobid、最近 succeeded 时间、探针 dose id 与终态 |
| **每月一次**（例行） | 2.1 + 2.3 + 2.4 | 一行结论：健康 / 异常及现象编号 |
| **用户反馈「漏服红条不出现」时（第一响应）** | 立即跑 2.1 → 2.2 → 2.3 → 2.4，再对用户所指剂量跑 3.1 路径二的探针查询 | 先判「cron 侧 / 客户端侧」，再决定是否立项；不要用前端改状态替代 |
| 观察到 `failed` 后 | 每天复查一次直到连续 3 次 `succeeded` | 记录 `return_message` 变化 |

## 5. 明确不做的事

| 不做 | 原因 |
|---|---|
| 加告警推送（企微/短信/邮件） | 本项目无服务端常驻服务与推送通道；巡检靠人工三查，避免引入新基础设施 |
| 修改 cron 表达式（如加密到 `*/1`） | 周期属 test-plan §6 #14 待裁决项，改表达式须走裁决与回归，不在运维清单内 |
| 手动 `UPDATE medication_doses SET status='missed'` | 会掩盖 cron 故障，并使 UI 状态与任务真实能力脱节；也违反 V2 关账后的数据纪律 |
| 用前端把 `overdue+pending` 渲染成漏服 | 同上：状态必须由数据库翻转，不能由展示层代偿 |
| `cron.unschedule` 预清理后重建 | 对不存在的任务名会抛 `XX000`，且重建会更换 jobid，切断历史运行记录 |

> 本清单的边界是「看见」而非「修复」：发现异常后按 §3 定位，变更（重跑 04、恢复 active、迁移数据）一律另立变更单并按授权执行。
