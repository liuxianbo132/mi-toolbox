-- ============================================================
-- 06-soft-delete.sql · 回收站（软删除）结构变更（幂等可重跑）
-- 2026-11-23 · 契约 v2.0
--
-- 约定：
--   is_deleted  过滤字段（所有用户可见查询 .eq('is_deleted', false)）
--   deleted_at  仅用于回收站展示「删除于何时」，不参与任何判断
--   恢复只写 is_deleted = false（SDK 会丢弃 null，不可用置空 deleted_at 方案）
--
-- ⚠️ 本环境 exec_sql 的 migrate 模式不支持多语句，
--    实际执行时请逐条：
--    ALTER ... / ALTER ... / ALTER ... / ALTER ... / CREATE INDEX ... / CREATE INDEX ...
-- ============================================================

ALTER TABLE public.items ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_items_is_deleted ON public.items (household_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_batches_is_deleted ON public.batches (household_id, is_deleted);
