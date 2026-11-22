-- 03-m2-schema.sql · M2 药品增强四表（幂等可重跑）
-- 应用: wbapp_r53cbHLLmYxU6r3LT4wbA6 (小咪工具箱)
-- 依据: docs/data-contract.md v1.6 M2 节 + 总控续跑单 backend-resume.md（2026-11-20）
-- 日期: 2026-11-20 · 后端窗口
--
-- 内容: allergies / drug_allergy_links / medication_plans / medication_doses
--       + 索引 + RLS(4 表 ALL 策略, 同 02 现有写法) + GRANT(同 02: anon 仅 SELECT)
-- 约定: status/kind 等枚举无 CHECK, 应用层约定（契约通用约定节）;
--       medication_doses.status = 'pending'|'taken'|'missed'|'escalated', 'escalated' 本期不使用, missed 为终态(v1.3)。
-- 裁量（汇报总控）: drug_allergy_links.kind 契约未定默认值, 按保守方向 DEFAULT 'forbidden'
--       （宁可误报禁用不漏报）; 漏服翻转 SQL 的 plans JOIN 版本见 04-cron-jobs.sql
--       （续跑单示意 SQL 缺 JOIN, 直接执行会 42703: miss_threshold_minutes 在 plans 表）。
-- FK 说明: 对齐旧环境现有模式——household_id 一律不加 FK(items/batches 先例);
--       member_id / item_id / plan_id 加 FK（契约通用约定节明确为外键列）。

-- ---------------------------------------------------------------------------
-- 1. allergies · 成员过敏档案（member_id→members）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allergies (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id    BIGINT NOT NULL,
  household_id BIGINT NOT NULL,
  allergen     TEXT   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT allergies_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id)
);
CREATE INDEX IF NOT EXISTS idx_allergies_member ON public.allergies (member_id);

-- ---------------------------------------------------------------------------
-- 2. drug_allergy_links · 药品×过敏原显式关联（item_id→items）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.drug_allergy_links (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id BIGINT NOT NULL,
  item_id      BIGINT NOT NULL,
  allergen     TEXT   NOT NULL,
  kind         TEXT   NOT NULL DEFAULT 'forbidden',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drug_allergy_links_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id)
);
CREATE INDEX IF NOT EXISTS idx_drug_allergy_links_item ON public.drug_allergy_links (item_id);

-- ---------------------------------------------------------------------------
-- 3. medication_plans · 用药计划（times=jsonb 时间点数组; miss_threshold_minutes 供 cron 翻转判定）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.medication_plans (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id          BIGINT NOT NULL,
  item_id               BIGINT NOT NULL,
  member_id             BIGINT NOT NULL,
  times                 JSONB  NOT NULL,
  freq                  TEXT   NOT NULL DEFAULT 'daily',
  start_date            DATE   NOT NULL,
  end_date              DATE,
  miss_threshold_minutes INTEGER NOT NULL DEFAULT 30,
  status                TEXT   NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT medication_plans_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT medication_plans_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id)
);
CREATE INDEX IF NOT EXISTS idx_medication_plans_household ON public.medication_plans (household_id);

-- ---------------------------------------------------------------------------
-- 4. medication_doses · 服药场次（plan_id→plans; cron 每 5 分钟翻转 missed）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.medication_doses (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id BIGINT NOT NULL,
  plan_id      BIGINT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  status       TEXT   NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT medication_doses_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.medication_plans(id)
);
CREATE INDEX IF NOT EXISTS idx_medication_doses_plan ON public.medication_doses (plan_id);
CREATE INDEX IF NOT EXISTS idx_medication_doses_status_sched ON public.medication_doses (status, scheduled_at);

-- ---------------------------------------------------------------------------
-- 5. RLS 开关 + 策略（4 条 ALL, 同 02 items_all 写法）
-- ---------------------------------------------------------------------------
ALTER TABLE public.allergies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drug_allergy_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medication_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medication_doses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allergies_all ON public.allergies;
CREATE POLICY allergies_all ON public.allergies FOR ALL
  USING (household_id IN (SELECT my_household_ids() AS my_household_ids))
  WITH CHECK (household_id IN (SELECT my_household_ids() AS my_household_ids));

DROP POLICY IF EXISTS drug_allergy_links_all ON public.drug_allergy_links;
CREATE POLICY drug_allergy_links_all ON public.drug_allergy_links FOR ALL
  USING (household_id IN (SELECT my_household_ids() AS my_household_ids))
  WITH CHECK (household_id IN (SELECT my_household_ids() AS my_household_ids));

DROP POLICY IF EXISTS medication_plans_all ON public.medication_plans;
CREATE POLICY medication_plans_all ON public.medication_plans FOR ALL
  USING (household_id IN (SELECT my_household_ids() AS my_household_ids))
  WITH CHECK (household_id IN (SELECT my_household_ids() AS my_household_ids));

DROP POLICY IF EXISTS medication_doses_all ON public.medication_doses;
CREATE POLICY medication_doses_all ON public.medication_doses FOR ALL
  USING (household_id IN (SELECT my_household_ids() AS my_household_ids))
  WITH CHECK (household_id IN (SELECT my_household_ids() AS my_household_ids));

-- ---------------------------------------------------------------------------
-- 6. GRANT（同 02 模式）
-- ---------------------------------------------------------------------------
GRANT SELECT ON TABLE public.allergies TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.allergies TO authenticated;
GRANT SELECT ON TABLE public.drug_allergy_links TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.drug_allergy_links TO authenticated;
GRANT SELECT ON TABLE public.medication_plans TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.medication_plans TO authenticated;
GRANT SELECT ON TABLE public.medication_doses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.medication_doses TO authenticated;
