-- 04-cron-jobs.sql · pg_cron 定时任务（幂等可重跑）
-- 应用: wbapp_r53cbHLLmYxU6r3LT4wbA6 (小咪工具箱)
-- 依据: docs/data-contract.md v1.6 M2 节 + 总控续跑单 backend-resume.md 第 4 步
-- 日期: 2026-11-20 · 后端窗口
-- 前置: pg_cron 扩展已装（sql/00-extensions.sql）
--
-- 任务: 漏服翻转——scheduled_at + miss_threshold_minutes 已过仍未确认的 pending 场次 → 'missed'
-- 周期: 每 5 分钟（'*/5 * * * *'；续跑单指定。最终执行周期为 test-plan §6 #14
--       待裁决项，M2 开工前总控拍板，改周期只需改下方 schedule 参数重跑）
--
-- 幂等机制（2026-11-20 实测）: pg_cron 1.6 的 cron.schedule(job_name, ...) 对同名任务是
--   upsert 语义——重复执行返回同一 jobid, 不产生重复任务; 直接重跑本文件即可。
--   ⚠️ 勿用 cron.unschedule 预清理: 对不存在的任务名它会抛错
--   （DATABASE_XX000: could not find valid entry）, 并非静默返回 false。
--
-- ⚠️ 实现说明（与续跑单示意 SQL 的差异）: 示意版
--   UPDATE medication_doses SET status='missed' WHERE status='pending'
--          AND scheduled_at + (miss_threshold_minutes * interval '1 minute') < now()
--   中 miss_threshold_minutes 是 medication_plans 的列, doses 表没有, 直接执行会 42703。
--   落库版本为 plans JOIN 版（语义一致）:
--   UPDATE medication_doses d SET status='missed' FROM medication_plans p
--    WHERE d.plan_id = p.id AND d.status='pending'
--      AND d.scheduled_at + (p.miss_threshold_minutes * interval '1 minute') < now()
--
-- 权限说明: cron 任务以 schedule 调用者（migrate 管理角色 = 各表 owner）执行,
--   relforcerowsecurity=false, 表 owner 天然 bypass RLS, 翻转不受行级安全拦截。
-- 'escalated' 本期不使用(v1.3): missed 即终态, 升级呈现 = 看板红标, 不发微信消息。

SELECT cron.schedule(
  'mi-toolbox-miss-dose-flip',
  '*/5 * * * *',
  $task$UPDATE public.medication_doses d
   SET status = 'missed'
   FROM public.medication_plans p
   WHERE d.plan_id = p.id
     AND d.status = 'pending'
     AND d.scheduled_at + (p.miss_threshold_minutes * interval '1 minute') < now()$task$
);
