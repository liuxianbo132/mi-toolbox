# 总控续跑单 · 后端窗口（2026-11-20 21:45）

## 背景（自包含，无需其他对话上下文）

- 双应用身份错位修复后，生产环境收敛到 `wbapp_r53cbHLLmYxU6r3LT4wbA6`（依据：docs/data-contract.md v1.6「环境身份」节）。
- 上轮执行被中断。断点状态（总控已实查）：`sql/02-base-schema.sql` 已完整落库（6 张基础表 + 9 条 RLS 策略 + `my_household_ids()` + `items.visibility` 列均在库）；`sql/01-rpc-household.sql` 未开始；M2 未开始。
- 旧应用 `wbapp_mCzPMhf3up1PsJr96aYq59` 已冻结（R6 裁决）：勿删、勿改、勿跑任何写操作，仅作只读参照。

## 执行清单（按缺口执行，已完成部分跳过）

1. 逐条执行 `sql/01-rpc-household.sql`（migrate 模式）：
   - `items.visibility` 会因 02 已含该列而自动跳过（ADD COLUMN IF NOT EXISTS，无害）
   - 4 个 RPC 正常落库
   - 完成标志：public 下共 5 个函数 = `my_household_ids`, `join_household`, `create_household`, `leave_household`, `remove_member`
2. 先跑 `sql/00-extensions.sql`（新环境 pg_cron / pgcrypto 未安装；不装则第 4 步建不了 cron 任务）
3. M2 落库（口径 = docs/data-contract.md v1.6 M2 节）：
   - 四表：`allergies` / `drug_allergy_links` / `medication_plans` / `medication_doses`，各配 RLS（写法参照 02 里现有策略：ALL 策略，`household_id IN (SELECT my_household_ids())`）
   - `medication_doses.status` = 'pending' | 'taken' | 'missed' | 'escalated'；'escalated' 本期不使用，missed 为终态
4. 部署 pg_cron 漏服翻转任务（每 5 分钟）：
   UPDATE medication_doses SET status='missed' WHERE status='pending' AND scheduled_at + (miss_threshold_minutes * interval '1 minute') < now()
   - 说明：最终执行周期是 test-plan §6 #14 待裁决项（M2 开工前总控拍板），先落 5 分钟不阻塞
5. 全部语句落档 `sql/03-m2-schema.sql`（cron 部分可单独 04，命名自定）——留档纪律（契约 v1.6）：不允许出现"只在库里、不在文件里"的资产

## 回报格式（完成即回报总控，附四项验证）

1. 表清单：应为 10 张 = 6 基础（households/members/items/batches/locations/records）+ 4 M2
2. 函数清单：应为 5 个
3. RLS 策略总数：应为 9 + M2 新增数
4. cron 任务：`SELECT * FROM cron.job` 应有一条漏服翻转任务
