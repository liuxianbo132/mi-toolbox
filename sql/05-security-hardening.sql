-- ============================================================
-- 05-security-hardening.sql · members 表越权加固（幂等可重跑）
-- 2026-11-23
--
-- 背景（原策略 WITH CHECK 只校验 owner_id，未约束 household_id 与 role）：
--   ① 成员可直接 UPDATE 自己行的 household_id 指向任意家庭 —— RLS 的
--      my_household_ids() 立即生效，等价于「潜入他人家庭」
--   ② 成员可直接 UPDATE 自己行的 role = 'owner' —— 家庭内权限提升
--
-- 处置：
--   ① 策略 WITH CHECK 增加 household_id ∈ my_household_ids()。
--      正常的「改昵称」不受影响：household_id 不变，仍在集合内。
--   ② 触发器禁止 role 变更。role 仅在 INSERT 时确定；
--      create_household / join_household 是 INSERT，
--      leave_household / remove_member 是 DELETE，均不触发本约束。
--
-- 说明：四个家庭 RPC 均为 SECURITY DEFINER，绕过 RLS，不受策略改动影响。
-- 回滚：重建 members_all 策略为 03 行同款 WITH CHECK (owner_id = auth.uid())，
--      并 DROP TRIGGER members_role_immutable。
-- ============================================================

DROP POLICY IF EXISTS members_all ON public.members;
CREATE POLICY members_all ON public.members FOR ALL
  USING ((owner_id = auth.uid()) OR (household_id IN (SELECT my_household_ids() AS my_household_ids)))
  WITH CHECK ((owner_id = auth.uid()) AND (household_id IN (SELECT my_household_ids() AS my_household_ids)));

CREATE OR REPLACE FUNCTION public.prevent_member_role_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'members.role is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS members_role_immutable ON public.members;
CREATE TRIGGER members_role_immutable
  BEFORE UPDATE ON public.members
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_member_role_change();
