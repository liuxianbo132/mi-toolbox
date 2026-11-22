-- 00-extensions.sql · 云数据库扩展环境留档（幂等可重跑）
-- 应用: wbapp_mCzPMhf3up1PsJr96aYq59 (小咪工具箱)
-- 校对日期: 2026-11-19 · 后端窗口
--
-- 任务 2 结论（定时任务能力验证）：
-- 1. WorkBuddy 云服务应用模型仅有 Database / Auth / Storage / LLM API 四模块，
--    无云函数 / 后台任务 / 服务端推送模块（skill 文档 + MCP 工具清单 + 官方文档三重确认）。
-- 2. 数据库级定时任务：pg_cron 1.6 实测可用 ——
--    CREATE EXTENSION 成功 → cron.schedule 入表成功 → cron.job_run_details
--    连续两个整分钟 status=succeeded（14:48:00 / 14:49:00）。
-- 3. 定时触发推送：不可行。数据库无 http/pg_net 出网扩展；
--    唯一出网桥 tencentdb_scf 仅能调 CloudBase 云函数（path 强制 '/v1/functions/' 前缀），
--    需用户自持 CloudBase 环境 + API key，WorkBuddy 应用模型内无云函数可调。
-- 4. 最终结论：推送降级方案生效 —— 前端按「打开小程序惰性计算 + 看板红点兜底」实现；
--    M2 漏服判定（scheduled_at + miss_threshold_minutes 未确认 → missed）等数据库内
--    定时 SQL 任务可用 pg_cron 承接（方案待总控裁决后另行落库）。
--
-- 环境现状：
--   pg_cron   1.6   已安装（保留，M2 漏服判定候选方案）
--   pgcrypto  1.x   已安装（探测 tencentdb_scf 时安装的依赖，保留，通用加密函数库）
--   tencentdb_scf   已卸载（探测用，探测完即卸载恢复原状）
--   cron 测试 job jobid=1 已 unschedule；cron.job_run_details 中的测试执行记录为
--   系统历史表，平台自动滚动清理，无需手动处理。

-- 如需在新环境复现扩展（幂等）：
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
