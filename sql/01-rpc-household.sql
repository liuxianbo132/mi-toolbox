-- 01-rpc-household.sql · v1.2 成员关系 RPC + items.visibility（幂等可重跑）
-- 应用: wbapp_mCzPMhf3up1PsJr96aYq59 (小咪工具箱)
-- 依据: docs/briefs/ruling-request.md 裁决回执 R2 + docs/data-contract.md v1.3「RPC / 函数」节
-- 日期: 2026-11-19 · 后端窗口
--
-- 变更内容:
--   1. items 加列 visibility（契约 v1 通用约定即预留，本批落库）
--   2. join_household 行为变更: 已有任一家庭 -> 'already_joined'（覆盖 v1.1 ON CONFLICT DO NOTHING 旧语义）
--   3. 新增 create_household(p_name): 原子建 households + owner 成员; invite_code 服务端生成
--      （沿用旧前端 'HB' + 6 位大写字母数字格式, pages/home/home.js:137）
--   4. 新增 leave_household(): owner -> 'owner_cannot_leave'; member 删自身记录
--   5. 新增 remove_member(p_member_id): owner-only、限本家庭、限 role='member'
--
-- 语义约定（契约 v1.2「成员关系变更语义」节）:
--   - 一人一家庭: 跨家重复由 join/create 两 RPC 在入口拦截
--   - 成员删除经 SECURITY DEFINER RPC 完成, RLS 零改动
--   - owner 不可退出/解散（V1 不做）
--
-- 已知裁量（未进契约, 汇报总控确认）:
--   - leave_household / remove_member 增加 'not_signed_in' 兜底分支（未登录调用）
--   - create_household 单参数, owner 成员 nickname 不落库（旧流程有）, 前端以 session 用户名兜底显示
--   - 空家庭名: CREATE OR REPLACE 层 RAISE EXCEPTION 拦截（前端旧代码已拦截, 双保险）
--
-- 行为验证边界: RPC 依赖 auth.uid(), migrate 管理会话恒为 NULL, 深度行为用例
--   （already_joined / ok / owner_cannot_leave 等）由测试窗口以真实登录态覆盖。

-- ---------------------------------------------------------------------------
-- 1. items.visibility
-- ---------------------------------------------------------------------------
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'household';

COMMENT ON COLUMN public.items.visibility IS
  '可见性预留: household=家庭内可见; public 预留未启用(V1 不做公开读写)';

-- ---------------------------------------------------------------------------
-- 2. join_household(p_code text) — v1.2 行为变更
--    返回: 'not_signed_in' | 'already_joined' | 'not_found' | 'ok'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.join_household(p_code text)
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

  -- v1.2 一人一家庭: 已有任一家庭即拒绝（先判拦截, 不泄露 code 有效性）
  IF EXISTS (SELECT 1 FROM public.members WHERE owner_id = v_uid) THEN
    RETURN 'already_joined';
  END IF;

  SELECT id INTO v_hid FROM public.households WHERE invite_code = p_code;
  IF v_hid IS NULL THEN
    RETURN 'not_found';
  END IF;

  INSERT INTO public.members (household_id, owner_id, role)
  VALUES (v_hid, v_uid, 'member');

  RETURN 'ok';
END;
$fn$;

COMMENT ON FUNCTION public.join_household(text) IS
  'v1.2: 凭邀请码加入家庭(一人一家庭, 已有家庭返回 already_joined)';

-- ---------------------------------------------------------------------------
-- 3. create_household(p_name text) — v1.2 新增
--    返回: 'not_signed_in' | 'already_joined' | 'ok'
--    原子性: plpgsql 函数体整体单事务, 任一步失败全回滚
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_household(p_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid TEXT;
  v_hid BIGINT;
  v_code TEXT;
  i INT;
  j INT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN 'not_signed_in';
  END IF;

  -- v1.2 一人一家庭: 已有任一家庭即拒绝
  IF EXISTS (SELECT 1 FROM public.members WHERE owner_id = v_uid) THEN
    RETURN 'already_joined';
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'household name must not be empty';
  END IF;

  -- invite_code: 'HB' + 6 位大写字母数字（沿用旧前端格式）; 撞码重试至多 5 次,
  -- 36^6 ≈ 2.17e9, UNIQUE(invite_code) 兜底
  FOR i IN 1..5 LOOP
    v_code := 'HB';
    FOR j IN 1..6 LOOP
      v_code := v_code || substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
                                 floor(random() * 36)::int + 1, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.households WHERE invite_code = v_code);
  END LOOP;

  INSERT INTO public.households (owner_id, name, invite_code)
  VALUES (v_uid, btrim(p_name), v_code)
  RETURNING id INTO v_hid;

  -- owner 成员记录; nickname 不落库(旧流程有), 由前端 session 用户名兜底显示
  INSERT INTO public.members (household_id, owner_id, role)
  VALUES (v_hid, v_uid, 'owner');

  RETURN 'ok';
END;
$fn$;

COMMENT ON FUNCTION public.create_household(text) IS
  'v1.2: 原子创建家庭+owner成员, invite_code 服务端生成(HB+6位)';

-- ---------------------------------------------------------------------------
-- 4. leave_household() — v1.2 新增
--    返回: 'not_signed_in' | 'not_found' | 'owner_cannot_leave' | 'ok'
--    (not_signed_in / not_found 为实现层兜底, 契约仅约定 owner_cannot_leave)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leave_household()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid TEXT;
  v_mid BIGINT;
  v_role TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN 'not_signed_in';
  END IF;

  -- 一人一家庭: 取本人成员记录(按加入时间最早一条)
  SELECT id, role INTO v_mid, v_role
  FROM public.members
  WHERE owner_id = v_uid
  ORDER BY joined_at
  LIMIT 1;

  IF v_mid IS NULL THEN
    RETURN 'not_found';
  END IF;

  IF v_role = 'owner' THEN
    RETURN 'owner_cannot_leave';
  END IF;

  DELETE FROM public.members WHERE id = v_mid;
  RETURN 'ok';
END;
$fn$;

COMMENT ON FUNCTION public.leave_household() IS
  'v1.2: member 自退家庭(删自身成员记录, RLS 随即失去可见性); owner 被拒';

-- ---------------------------------------------------------------------------
-- 5. remove_member(p_member_id bigint) — v1.2 新增
--    返回: 'not_signed_in' | 'forbidden' | 'not_found' | 'ok'
--    caller 非 owner -> 'forbidden'; 目标不在本家庭 -> 'not_found';
--    目标非 member(即 owner, 一人一家庭下=caller 自身) -> 'forbidden' 防自删
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_member(p_member_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid TEXT;
  v_hid BIGINT;
  v_target_role TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN 'not_signed_in';
  END IF;

  SELECT household_id INTO v_hid
  FROM public.members
  WHERE owner_id = v_uid AND role = 'owner';

  IF v_hid IS NULL THEN
    RETURN 'forbidden';
  END IF;

  SELECT role INTO v_target_role
  FROM public.members
  WHERE id = p_member_id AND household_id = v_hid;

  IF v_target_role IS NULL THEN
    RETURN 'not_found';
  END IF;

  IF v_target_role <> 'member' THEN
    RETURN 'forbidden';
  END IF;

  DELETE FROM public.members WHERE id = p_member_id;
  RETURN 'ok';
END;
$fn$;

COMMENT ON FUNCTION public.remove_member(bigint) IS
  'v1.2: owner 移除本家庭 member(限 role=member, 防移除 owner/他家成员)';
