-- 07-medication-safety.sql · P0 用药安全与数据一致性（幂等可重跑）
-- 应用: wbapp_r53cbHLLmYxU6r3LT4wbA6 (小咪工具箱)
-- 依据: 2026-11-24 用药安全优化任务（P0-2 服务端拦截 / P0-3 原子更新）
-- 日期: 2026-11-24
--
-- 变更内容（纯新增函数，不改表结构、不改 RLS、不动存量数据）:
--   1. transition_dose(p_dose_id, p_target_status)
--      服务端打卡边界：pending→taken 时按「计划服药人 member_id」的过敏档案
--      校验药品 drug_allergy_links，命中 forbidden 直接拒绝；
--      taken→missed 为误打卡更正通道（保留记录行，confirmed_at 置空）。
--   2. cancel_plan_atomic(p_plan_id)
--      取消计划原子化：事务内一次性完成 plan.status='cancelled'
--      + 删除未来 pending doses，消除"计划已取消但提醒残留"。
--   3. replace_future_doses(p_plan_id, p_rows)
--      计划编辑原子化：事务内删除未来 pending + 批量重建，消除
--      "部分失败产生重复/遗漏提醒"。
--
-- 语义约定:
--   - SECURITY DEFINER 绕过 RLS，所有函数显式校验 my_household_ids() 归属
--   - transition_dose 合法迁移仅有两条：pending→taken（含冲突校验）、taken→missed（更正）
--   - pending→missed 由 pg_cron 负责翻转，客户端不得手动触发
--   - 历史行永不删除：更正只改 status，不 DELETE
--
-- 前端兼容: 所有函数未部署前，前端调用报错即自动回退旧多步流程（见
--   pages/medication/medication.js / pages/plan-form/plan-form.js），行为不变。
--
-- 回滚（纯函数级，无表/数据变更）:
--   DROP FUNCTION IF EXISTS public.transition_dose(bigint, text);
--   DROP FUNCTION IF EXISTS public.cancel_plan_atomic(bigint);
--   DROP FUNCTION IF EXISTS public.replace_future_doses(bigint, jsonb);

-- ---------------------------------------------------------------------------
-- 1. transition_dose(p_dose_id bigint, p_target_status text)
--    返回: 'ok' | 'not_signed_in' | 'not_found' | 'forbidden_household'
--        | 'invalid_transition' | 'forbidden_allergy'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_dose(
  p_dose_id bigint,
  p_target_status text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid TEXT;
  v_hid BIGINT;
  v_item_id BIGINT;
  v_member_id BIGINT;
  v_current TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN 'not_signed_in';
  END IF;

  IF p_target_status NOT IN ('taken', 'missed') THEN
    RETURN 'invalid_transition';
  END IF;

  SELECT d.household_id, d.status, p.item_id, p.member_id
    INTO v_hid, v_current, v_item_id, v_member_id
  FROM public.medication_doses d
  JOIN public.medication_plans p ON p.id = d.plan_id
  WHERE d.id = p_dose_id;

  IF v_hid IS NULL THEN
    RETURN 'not_found';
  END IF;

  -- 归属校验（RLS 在 SECURITY DEFINER 下不生效，显式校验）
  IF NOT EXISTS (SELECT 1 FROM my_household_ids() h WHERE h = v_hid) THEN
    RETURN 'forbidden_household';
  END IF;

  -- 合法迁移白名单：打卡与误打卡更正各一条路径
  IF NOT (
       (v_current = 'pending' AND p_target_status = 'taken')
    OR (v_current = 'taken'  AND p_target_status = 'missed')
  ) THEN
    RETURN 'invalid_transition';
  END IF;

  -- 服务端过敏边界：按计划服药人档案判断，命中 forbidden 拒绝打卡（P0-2）
  IF v_current = 'pending' THEN
    IF EXISTS (
      SELECT 1
      FROM public.drug_allergy_links l
      WHERE l.item_id = v_item_id
        AND l.kind = 'forbidden'
        AND l.allergen IN (
          SELECT a.allergen FROM public.allergies a WHERE a.member_id = v_member_id
        )
    ) THEN
      RETURN 'forbidden_allergy';
    END IF;
  END IF;

  UPDATE public.medication_doses
     SET status = p_target_status,
         confirmed_at = CASE WHEN p_target_status = 'taken' THEN now() ELSE NULL END
   WHERE id = p_dose_id;

  RETURN 'ok';
END;
$fn$;

COMMENT ON FUNCTION public.transition_dose(bigint, text) IS
  'P0-2: 打卡/更正原子操作；pending→taken 校验服药人过敏禁用；taken→missed 保留历史行';

-- ---------------------------------------------------------------------------
-- 2. cancel_plan_atomic(p_plan_id bigint)
--    返回: 'ok' | 'not_signed_in' | 'not_found' | 'forbidden_household'
--    原子性: 函数体单事务——plan 置 cancelled 与删未来 pending 同生共死
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_plan_atomic(p_plan_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid TEXT;
  v_hid BIGINT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN 'not_signed_in';
  END IF;

  SELECT household_id INTO v_hid FROM public.medication_plans WHERE id = p_plan_id;
  IF v_hid IS NULL THEN
    RETURN 'not_found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM my_household_ids() h WHERE h = v_hid) THEN
    RETURN 'forbidden_household';
  END IF;

  UPDATE public.medication_plans SET status = 'cancelled' WHERE id = p_plan_id;

  DELETE FROM public.medication_doses
   WHERE plan_id = p_plan_id
     AND status = 'pending'
     AND scheduled_at > now();

  RETURN 'ok';
END;
$fn$;

COMMENT ON FUNCTION public.cancel_plan_atomic(bigint) IS
  'P0-3: 取消计划原子化——状态翻转与未来提醒清理同事务；历史 taken/missed 保留';

-- ---------------------------------------------------------------------------
-- 3. replace_future_doses(p_plan_id bigint, p_rows jsonb)
--    p_rows: [{"scheduled_at": "2026-11-25T08:00:00.000Z"}, ...]（仅时间点）
--    返回: 'ok' | 'not_signed_in' | 'not_found' | 'forbidden_household'
--    幂等: 重复调用安全——先删未来 pending 再重建，已发生记录不动
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.replace_future_doses(
  p_plan_id bigint,
  p_rows jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid TEXT;
  v_hid BIGINT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN 'not_signed_in';
  END IF;

  SELECT household_id INTO v_hid FROM public.medication_plans WHERE id = p_plan_id;
  IF v_hid IS NULL THEN
    RETURN 'not_found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM my_household_ids() h WHERE h = v_hid) THEN
    RETURN 'forbidden_household';
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) NOT IN ('array', 'null') THEN
    RAISE EXCEPTION 'p_rows must be a jsonb array';
  END IF;

  DELETE FROM public.medication_doses
   WHERE plan_id = p_plan_id
     AND status = 'pending'
     AND scheduled_at > now();

  -- household_id / plan_id 以 plan 行为准，不信任客户端传入值
  INSERT INTO public.medication_doses (household_id, plan_id, scheduled_at, status)
  SELECT v_hid, p_plan_id, (r->>'scheduled_at')::timestamptz, 'pending'
  FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
  WHERE r->>'scheduled_at' IS NOT NULL;

  RETURN 'ok';
END;
$fn$;

COMMENT ON FUNCTION public.replace_future_doses(bigint, jsonb) IS
  'P0-3: 计划编辑原子化——单事务内删除未来 pending 并按新时间点重建';
