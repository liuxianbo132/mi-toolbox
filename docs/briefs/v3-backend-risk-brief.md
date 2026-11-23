# V3 后端风险与决策 brief（2026-11-23）

> 状态：候选议题，不代表 V3 已立项或已授权实施。V2 已关账；本文件只记录风险、建议和实施前门槛，不执行 DDL 或数据变更。
> 依据：`sql/01-rpc-household.sql`、`sql/02-base-schema.sql`、`sql/03-m2-schema.sql`、`sql/04-cron-jobs.sql`、`utils/data-access.js`、`docs/data-contract.md`、`docs/evidence/2026-11-22-v2-03-execution.md`。

## 发布阻塞复核：漏服 cron 正常（2026-11-23 13:56 已排除）

> **结论更新**：总控 `exec_sql` 只读诊断证实——job `mi-toolbox-miss-dose-flip` **active=true**、`*/5 * * * *`，最近 10 轮全部 succeeded；探针剂量 id=21（plan 3，11-23 00:00，阈值 10 分钟）**终态为 missed**；当日 missed 共 2 条（id=11/id=21）；当前 pending 剂量 `overdue` 全为 false。原 01:42 的 pending 观察为**检查时点早于 cron 翻转或页面缓存**，不是任务故障，**发布阻塞不成立**。以下保留原诊断记录供追溯（其只读验证步骤仍可作为后续运维排查模板）。

**现象与证据**

- `docs/briefs/release-smoke-checklist.md` 记录：隔离探针 `[TEST]钙片` 的计划起止日为 2026-11-23、时间 `00:00`、阈值 10 分钟；约 01:36 +08 保存并生成 1 条 pending dose，约 01:42 +08 客户端仍显示待确认，首页无漏服红标。当前版本漏服链路未通过，发布门槛未满足。
- `docs/evidence/2026-11-21-m2a-execution.md` 记录旧验收时 cron 曾成功运行，job 每 5 分钟且 `UPDATE 1`，但旧成功记录不能证明 11 月 23 日任务仍 active、仍在目标数据库运行或近期执行成功。
- 本次检查可见工具清单没有 WorkBuddy/数据库连接或 `exec_sql` 查询能力；不能读取当前生产 `cron.job`、`cron.job_run_details`、服务端时钟或探针行。此为诊断阻塞，不是数据库已坏的证据。

**代码与时区判断**

- `sql/04-cron-jobs.sql` 的谓词是 `d.status='pending'` 且 `d.scheduled_at + p.miss_threshold_minutes * interval '1 minute' < now()`。若剂量行关联的计划阈值为 10，且服务端当前时间晚于 `due_at`，正常运行的任务应翻转该行。
- `utils/plan-doses.js` 按客户端本地时区构造剂量时间，再转 ISO UTC 写入 `timestamptz`。当设备确为 +08，00:00 会序列化为前一日 16:00Z；`timestamptz` 与 `now()` 比较仍按同一绝对时间轴，数据库时区设置通常只改变显示，不解释持续 pending。
- `pages/medication/medication.js` 在 `onShow()` 调用 `restore()` 并重新查询剂量；用药页不是仅依赖打开时缓存。首页也从数据库查询状态。当前没有证据支持通过客户端代码修复来代替后端状态翻转。
- **最可能但尚未证实：**当前数据库的 job 缺失/停用、执行失败，或 job 与客户端读写的应用数据库不一致。时区/客户端陈旧数据的可能性较低，但应通过读数排除。此处是基于代码与两次验收记录的推断。

**下一步只读验证（在确认目标是生产应用 `wbapp_r53cbHLLmYxU6r3LT4wbA6` 的数据库后执行）**

1. 确认任务是否存在、active、schedule 与 command：

   ```sql
   SELECT jobid, jobname, schedule, active, command
   FROM cron.job
   WHERE jobname = 'mi-toolbox-miss-dose-flip';
   ```

2. 查看最近运行时间、状态和返回错误：

   ```sql
   SELECT jobid, status, start_time, end_time, return_message
   FROM cron.job_run_details
   WHERE jobid = (
     SELECT jobid FROM cron.job
     WHERE jobname = 'mi-toolbox-miss-dose-flip'
   )
   ORDER BY start_time DESC
   LIMIT 20;
   ```

3. 在同一连接核对数据库时钟和探针实际 due time（以探针 plan/dose ID 代入；以下查询只读）：

   ```sql
   SELECT now(), clock_timestamp(), current_setting('TimeZone');

   SELECT d.id, d.status, d.scheduled_at,
          p.miss_threshold_minutes,
          d.scheduled_at + p.miss_threshold_minutes * interval '1 minute' AS due_at,
          now() > d.scheduled_at + p.miss_threshold_minutes * interval '1 minute' AS overdue
   FROM public.medication_doses d
   JOIN public.medication_plans p ON p.id = d.plan_id
   WHERE d.id = <probe_dose_id>;
   ```

4. 将这三类结果与客户端查询环境对应：job 缺失/停用则属调度配置；运行错误则据 `return_message` 定位；job 成功但 `overdue=true` 仍 pending 时，核对 job 数据库与小程序当前云应用是否同一环境及执行 command 是否与脚本一致；数据库已 missed 但 UI 未更新时，再检查客户端是否重新拉取和会话指向。

**代码层处置与放行门槛**

当前可见代码没有明确安全修复：客户端已按页面显示生命周期重新读状态，SQL 条件与契约一致。不要用前端把 overdue+pending 伪装成 missed，因为这会掩盖 cron 故障并让 UI 状态与数据库不一致。先完成上述只读诊断；如确认缺陷，再单独立项并按授权修复。

放行前必须在隔离测试数据上重新验证：创建未来剂量、等待超过阈值及一个 cron 周期、直接读取数据库确认 pending→missed，随后确认用药页与首页红标同步；记录 job 最近 succeeded 及执行结果。未满足前保持发布阻塞。不得为诊断手动更新 dose，也不得在本 brief 中重跑 cron/DDL。

## 优先级摘要

| 优先级 | 议题 | 建议决策 |
|---|---|---|
| P1 | 跨家庭关联完整性 | 先确定哪些 FK 必须与 `household_id` 同家庭，再设计复合约束或受控写路径；实施前做现存数据审计 |
| P1 | 一人一家庭并发竞态 | 保持产品语义，采用数据库级并发保护；先明确冲突时 RPC 返回值及迁移旧数据策略 |
| P2 | `owner_name` / 昵称契约 | 决定昵称归属、编辑权限、默认展示及历史流水是否回填；倾向当前昵称只影响新记录，历史快照不自动改写 |
| P3 | SQL 文件头环境标注 | 统一历史环境/生产环境说明，避免将脚本来源误读成目标环境；不改脚本 SQL 内容 |

## P1：跨家庭关联完整性

**证据**

- `sql/02-base-schema.sql`：`batches.item_id` 仅 FK 到 `items(id)`；`batches.household_id` 与 item 所属家庭没有联合约束。`locations` 没有 FK；`records.batch_id` 也没有 FK。
- `sql/03-m2-schema.sql`：过敏、药品关联、用药计划、doses 的 `household_id` RLS 均独立判定；`item_id`、`member_id`、`plan_id` 的 FK 只保证目标存在，不保证目标与本行 `household_id` 相同。
- `utils/data-access.js` 白名单允许业务写入各表的 `household_id` 和关联 ID；因此数据库完整性最终依赖调用方传值正确。

**影响**

具备有效家庭会话的调用方若提交错配的同表 ID，RLS 可能允许本家庭行写入，而普通 FK 只验证引用记录存在。可能出现跨家庭引用、列表遗漏/错误归属，或关联数据在家庭成员变更后行为不一致。当前前端正常流程按当前家庭组装 ID，尚无证据表明真实用户已制造错配。

**推荐方案**

先按业务关系建立映射：`batches→items/locations`、`records→batches`、`allergies→members`、`drug_allergy_links→items`、`medication_plans→items/members`、`medication_doses→plans`。对必须同家庭的关系，优先评估在被引用表上建立 `(household_id,id)` 唯一键并采用复合 FK；对有意允许历史/悬空关系的字段（例如位置删除后 `batches.location_id` 保留悬空 ID），保留当前语义，不强加 FK。`records.batch_id` 是否需要 FK/删除行为需先裁决，以免破坏流水留存。

**迁移与兼容风险**

- 现存脏关联会阻止新增约束；必须先只读盘点并明确修复、隔离或豁免规则。
- 复合 FK 可能增加写入成本，并要求前端/批量写入始终传一致 `household_id`。
- cascade/restrict/set-null 会改变物品、成员、计划删除时的生命周期；不得仅为“补齐 FK”擅自选择级联策略。
- 位置悬空 ID 是 V2 验收确认的产品语义，不可误判为需清理数据。

**进入实施前验收门槛**

1. 产品/总控批准每一种关联的同家庭规则及删除行为，明确 `records` 与悬空位置例外。
2. 对生产数据完成只读异常计数，输出按关系分类的样例与处置方案，异常归零或获得明确豁免。
3. 约束方案证明正常 CRUD、流水留存、退出/移除家庭以及位置删除语义不回归。
4. 在非生产环境验证既有数据迁移、非法跨家引用被拒、合法同家写入通过；准备回滚方案后再讨论生产变更。

## P1：一人一家庭并发竞态

**证据**

- `sql/01-rpc-household.sql` 的 `join_household` 与 `create_household` 都先查询 `members` 是否已有该 `owner_id`，再写入成员记录。
- `sql/02-base-schema.sql` 的唯一约束是 `(household_id, owner_id)`，阻止同一用户重复加入同一家庭，但不阻止同一用户同时属于不同家庭。
- 两条 RPC 均为 `SECURITY DEFINER`，可绕开普通成员写入 RLS；现有契约锁定一人一家庭。

**影响**

两个并发 RPC 可能同时通过“尚无家庭”检查，分别插入不同家庭成员记录，令数据库状态违反契约。单请求顺序执行的验收不能覆盖该竞态。

**推荐方案**

用数据库级原子约束或事务级并发控制实现全局唯一归属。优先比较 `members.owner_id` 唯一约束与 advisory lock/等价序列化方案：前者简单，但要求数据库中 owner_id 全局唯一并会影响未来多家庭设计；后者保留表结构弹性，但所有创建/加入入口必须使用同一锁键，实施及验证更复杂。实施前需决定冲突返回明确业务码还是保持现有返回集并由唯一冲突映射。

**迁移与兼容风险**

- 若历史数据已有跨家庭重复 `owner_id`，唯一约束将无法建立；先只读审计并决定保留哪个关系。
- 约束失败可能从 SDK 暴露为底层唯一冲突，需避免前端出现未处理错误或重试风暴。
- `create_household` 是家庭和 owner 成员的事务性创建；并发保护必须覆盖整个判定与插入关键区间。
- 若将来放宽为多家庭，唯一约束方案需要重新设计。

**进入实施前验收门槛**

1. 总控确认“一人一家庭”仍是长期规则，冲突时的 RPC 返回码及用户提示有定义。
2. 生产成员数据只读盘点确认无重复归属，或已有经批准的数据处置决议。
3. 并发验收覆盖同一用户同时 join 两家、join 与 create 并发、同类重复调用；所有场景最终最多一个家庭，返回值稳定且无半成品家庭。
4. 普通 not-signed-in、already-joined、not-found、成功路径回归通过。

## P2：`owner_name` / 昵称契约

**证据**

- `sql/02-base-schema.sql` 中 `members.nickname`、`batches.owner_name`、`records.owner_name` 均为可空字段；`sql/01-rpc-household.sql` 创建 owner 成员时不写 nickname。
- `utils/data-access.js` 的 `logRecord` 从 session 用户名读取 `owner_name`，无用户名时省略该字段。
- `docs/evidence/2026-11-22-v2-03-execution.md` 记录 V2 流水中 `owner_name` 全 null，操作人列为空；证据将其列为 V3 观察项。

**影响**

共享家庭中的成员无法从流水识别操作人；批次录入人也可能缺少可读名称。数据仍保留 `owner_id`，所以身份关联存在，但 UI 可读性和成员管理场景较弱。

**推荐方案**

V3 若纳入昵称能力，明确 `members.nickname` 是家庭内昵称还是账号全局昵称。建议先采用家庭内昵称：本人可编辑自己的 nickname；owner 是否可代改须裁决。写流水/批次时将当时昵称快照写入 `owner_name`；历史记录默认保留原快照，不自动回填，以免改变历史语义。若查看历史时想显示最新昵称，可作为独立 UI 决策，需同时展示“记录时快照”或明确采用动态名称。

**迁移与兼容风险**

- 旧行的 `owner_name` 为 NULL，回填需要确定数据来源；不能假设 session 用户名或当前昵称等于操作发生时名称。
- 微信登录不提供稳定昵称时，必须定义空值默认文案及重复/空白/长度校验。
- 一个 user 可在家庭中成为成员，nickname 更新权限需防止跨家庭修改。
- 更新昵称后动态改写历史流水会改变审计呈现；默认不建议回填或改写历史快照。

**进入实施前验收门槛**

1. 产品决策明确昵称作用域、谁可编辑、长度/空值规则，以及历史记录采用快照还是动态显示。
2. 定义无昵称、已退出/被移除成员、重复昵称的显示与查询行为。
3. 验收本人不能修改他人昵称、不能跨家庭读取/修改，且新流水保存正确快照；旧流水保持批准的兼容策略。

## P3：SQL 文件头环境标注整理

**证据**

- `sql/00-extensions.sql` 与 `sql/01-rpc-household.sql` 文件头标注冻结存档应用 `wbapp_mCzPMhf3up1PsJr96aYq59`。
- `sql/02-base-schema.sql` 至 `sql/04-cron-jobs.sql` 标注生产应用 `wbapp_r53cbHLLmYxU6r3LT4wbA6`。
- `docs/data-contract.md` 环境身份节说明后者为生产，前者冻结存档。

**影响与建议**

脚本头部可能让接手人误以为前两份脚本应在冻结环境执行。发布整理时统一说明“历史校验来源”与“当前目标环境”，保留脚本来源、日期和实际执行记录，不改变 SQL 语句或重跑任何脚本。

**进入整理前验收门槛**

逐份核对历史执行记录/云端对象归属；每个文件的目标环境、来源环境和是否可在生产重跑均有明确文字；不得把冻结环境标为可写目标。
