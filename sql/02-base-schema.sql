-- 02-base-schema.sql · 基础表结构留档（幂等可重跑）
-- 应用: wbapp_r53cbHLLmYxU6r3LT4wbA6 (小咪工具箱 · 新环境)
-- 来源: 从 wbapp_mCzPMhf3up1PsJr96aYq59 逆向导出（2026-11-20 只读快照, mCzPM 已冻结勿动 R6）
-- 执行: 逐条单语句 exec_sql migrate; 全部语句幂等（IF NOT EXISTS / OR REPLACE / DROP IF EXISTS）
--
-- 内容: my_household_ids() 函数 + 6 表(households/members/items/batches/locations/records)
--       + 6 非唯一索引 + RLS(6 表 ENABLE + 9 策略) + GRANT(anon 仅 SELECT, authenticated 全套)
-- 说明: items.visibility 已含在 items 建表内(实况快照); 01-rpc-household.sql 重跑时 ADD COLUMN
--       IF NOT EXISTS 自动跳过。函数级 EXECUTE ACL 为平台自动模板(PUBLIC/anon/authenticated/
--       service_role), 无需手工复刻。
-- 契约: docs/data-contract.md v1.3「现有表 / RLS 实况」节。

-- ---------------------------------------------------------------------------
-- 0. RLS 辅助函数（所有策略依赖, 必须先建）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_household_ids()
RETURNS SETOF bigint
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$ SELECT household_id FROM public.members WHERE owner_id = auth.uid() $fn$;

-- ---------------------------------------------------------------------------
-- 1. 建表（FK 依赖序: households / items 先行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.households (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    TEXT        NOT NULL DEFAULT auth.uid(),
  name        TEXT        NOT NULL,
  invite_code TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT households_invite_code_key UNIQUE (invite_code)
);

CREATE TABLE IF NOT EXISTS public.items (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id        BIGINT NOT NULL,
  name                TEXT   NOT NULL,
  barcode             TEXT,
  category            TEXT   NOT NULL DEFAULT 'food',
  brand               TEXT,
  spec                TEXT,
  unit                TEXT   DEFAULT '件',
  shelf_life_days     INTEGER,
  pao_days            INTEGER,
  low_stock_threshold INTEGER,
  remark              TEXT,
  visibility          TEXT   NOT NULL DEFAULT 'household',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.members (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id BIGINT NOT NULL,
  owner_id     TEXT   NOT NULL DEFAULT auth.uid(),
  role         TEXT   NOT NULL DEFAULT 'member',
  nickname     TEXT,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT members_household_id_fkey FOREIGN KEY (household_id)
    REFERENCES public.households(id) ON DELETE CASCADE,
  CONSTRAINT members_household_id_owner_id_key UNIQUE (household_id, owner_id)
);

CREATE TABLE IF NOT EXISTS public.batches (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id    BIGINT NOT NULL,
  item_id         BIGINT NOT NULL,
  production_date DATE,
  expiry_date     DATE   NOT NULL,
  quantity        NUMERIC NOT NULL DEFAULT 1,
  unit            TEXT,
  location_id     BIGINT,
  status          TEXT   NOT NULL DEFAULT 'active',
  opened_at       TIMESTAMPTZ,
  price           NUMERIC,
  source          TEXT,
  owner_id        TEXT   NOT NULL DEFAULT auth.uid(),
  owner_name      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT batches_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id)
);

CREATE TABLE IF NOT EXISTS public.locations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id BIGINT NOT NULL,
  name        TEXT   NOT NULL,
  kind        TEXT   DEFAULT 'pantry',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.records (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id BIGINT NOT NULL,
  batch_id     BIGINT,
  action       TEXT   NOT NULL,
  quantity     NUMERIC,
  note         TEXT,
  owner_id     TEXT   NOT NULL DEFAULT auth.uid(),
  owner_name   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. 非唯一索引（唯一索引由表约束自动生成）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_batches_household_expiry ON public.batches (household_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_item ON public.batches (item_id);
CREATE INDEX IF NOT EXISTS idx_items_household ON public.items (household_id);
CREATE INDEX IF NOT EXISTS idx_locations_household ON public.locations (household_id);
CREATE INDEX IF NOT EXISTS idx_members_owner ON public.members (owner_id);
CREATE INDEX IF NOT EXISTS idx_records_household ON public.records (household_id);

-- ---------------------------------------------------------------------------
-- 3. RLS 开关（重复执行无害）
-- ---------------------------------------------------------------------------
ALTER TABLE public.households ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batches   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.records   ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. RLS 策略（9 条, 角色为 PUBLIC; DROP IF EXISTS 保幂等）
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS households_select ON public.households;
CREATE POLICY households_select ON public.households FOR SELECT
  USING ((owner_id = auth.uid()) OR (id IN (SELECT my_household_ids() AS my_household_ids)));

DROP POLICY IF EXISTS households_insert ON public.households;
CREATE POLICY households_insert ON public.households FOR INSERT
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS households_update ON public.households;
CREATE POLICY households_update ON public.households FOR UPDATE
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS households_delete ON public.households;
CREATE POLICY households_delete ON public.households FOR DELETE
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS members_all ON public.members;
CREATE POLICY members_all ON public.members FOR ALL
  USING ((owner_id = auth.uid()) OR (household_id IN (SELECT my_household_ids() AS my_household_ids)))
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS items_all ON public.items;
CREATE POLICY items_all ON public.items FOR ALL
  USING (household_id IN (SELECT my_household_ids() AS my_household_ids))
  WITH CHECK (household_id IN (SELECT my_household_ids() AS my_household_ids));

DROP POLICY IF EXISTS batches_all ON public.batches;
CREATE POLICY batches_all ON public.batches FOR ALL
  USING (household_id IN (SELECT my_household_ids() AS my_household_ids))
  WITH CHECK (household_id IN (SELECT my_household_ids() AS my_household_ids));

DROP POLICY IF EXISTS locations_all ON public.locations;
CREATE POLICY locations_all ON public.locations FOR ALL
  USING (household_id IN (SELECT my_household_ids() AS my_household_ids))
  WITH CHECK (household_id IN (SELECT my_household_ids() AS my_household_ids));

DROP POLICY IF EXISTS records_all ON public.records;
CREATE POLICY records_all ON public.records FOR ALL
  USING (household_id IN (SELECT my_household_ids() AS my_household_ids))
  WITH CHECK (household_id IN (SELECT my_household_ids() AS my_household_ids));

-- ---------------------------------------------------------------------------
-- 5. GRANT（按 mCzPM 实况复刻: anon 仅 SELECT; authenticated 全套）
-- ---------------------------------------------------------------------------
GRANT SELECT ON TABLE public.households TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.households TO authenticated;
GRANT SELECT ON TABLE public.members TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.members TO authenticated;
GRANT SELECT ON TABLE public.items TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.items TO authenticated;
GRANT SELECT ON TABLE public.batches TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.batches TO authenticated;
GRANT SELECT ON TABLE public.locations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.locations TO authenticated;
GRANT SELECT ON TABLE public.records TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.records TO authenticated;
