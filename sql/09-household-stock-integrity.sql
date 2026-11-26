-- Apply after 08, in one transaction. No legacy rows are rewritten.
BEGIN;

-- Member management and invite/leave operations belong to the household RPCs.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.members FROM PUBLIC, anon, authenticated;
GRANT UPDATE (nickname) ON public.members TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.households FROM PUBLIC, anon, authenticated;
REVOKE TRUNCATE, TRIGGER ON public.items, public.batches, public.locations, public.records,
  public.allergies, public.drug_allergy_links FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS allergies_all ON public.allergies;
DROP POLICY IF EXISTS allergies_read ON public.allergies;
DROP POLICY IF EXISTS allergies_manage ON public.allergies;
CREATE POLICY allergies_read ON public.allergies FOR SELECT TO authenticated
  USING (household_id IN (SELECT public.my_household_ids()));
CREATE POLICY allergies_manage ON public.allergies FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m WHERE m.household_id = allergies.household_id
    AND m.owner_id = auth.uid() AND (m.id = allergies.member_id OR m.role = 'owner')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.members m WHERE m.household_id = allergies.household_id
    AND m.owner_id = auth.uid() AND (m.id = allergies.member_id OR m.role = 'owner'))
    AND EXISTS (SELECT 1 FROM public.members subject WHERE subject.id = allergies.member_id
      AND subject.household_id = allergies.household_id));

DROP POLICY IF EXISTS drug_allergy_links_all ON public.drug_allergy_links;
CREATE POLICY drug_allergy_links_all ON public.drug_allergy_links FOR ALL TO authenticated
  USING (household_id IN (SELECT public.my_household_ids()))
  WITH CHECK (household_id IN (SELECT public.my_household_ids())
    AND EXISTS (SELECT 1 FROM public.items i WHERE i.id = drug_allergy_links.item_id
      AND i.household_id = drug_allergy_links.household_id AND i.category = 'medicine' AND NOT i.is_deleted));

ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS deleted_with_item boolean NOT NULL DEFAULT false;

-- The trigger covers existing direct create/update entry points. Lock the parent on insert
-- so adding a batch and moving its parent to the trash cannot leave an active orphan.
CREATE OR REPLACE FUNCTION public.check_batch_integrity()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE
  v_item_deleted boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.household_id IS DISTINCT FROM OLD.household_id THEN
      RAISE EXCEPTION 'batch parent is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.is_deleted AND NEW.is_deleted THEN
      RAISE EXCEPTION 'restore a batch before editing it' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status <> 'active' OR NEW.status NOT IN ('used', 'discarded')) THEN
      RAISE EXCEPTION 'invalid batch status transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
      RAISE EXCEPTION 'batch opening time is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT i.is_deleted INTO v_item_deleted FROM public.items i
      WHERE i.id = NEW.item_id AND i.household_id = NEW.household_id FOR SHARE;
    IF NOT FOUND OR v_item_deleted THEN
      RAISE EXCEPTION 'batch requires an active item in the same household' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.quantity IS DISTINCT FROM OLD.quantity THEN
    IF NEW.quantity <= 0 OR NEW.quantity::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'batch quantity must be positive and finite' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    IF NEW.location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.locations l
      WHERE l.id = NEW.location_id AND l.household_id = NEW.household_id) THEN
      RAISE EXCEPTION 'batch location must belong to its household' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS check_batch_integrity ON public.batches;
CREATE TRIGGER check_batch_integrity BEFORE INSERT OR UPDATE ON public.batches
  FOR EACH ROW EXECUTE FUNCTION public.check_batch_integrity();

CREATE OR REPLACE FUNCTION public.set_stock_deleted(
  p_item_id bigint DEFAULT NULL, p_batch_id bigint DEFAULT NULL, p_deleted boolean DEFAULT NULL
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_item public.items%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_deleted_at timestamptz := CASE WHEN p_deleted THEN clock_timestamp() END;
BEGIN
  IF (p_item_id IS NULL) = (p_batch_id IS NULL) OR p_deleted IS NULL THEN RETURN 'invalid_target'; END IF;
  SELECT i.* INTO v_item FROM public.items i
  WHERE i.id = COALESCE(p_item_id, (SELECT b.item_id FROM public.batches b
    WHERE b.id = p_batch_id AND b.household_id IN (SELECT public.my_household_ids())))
    AND i.household_id IN (SELECT public.my_household_ids()) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT * INTO v_batch FROM public.batches
      WHERE id = p_batch_id AND item_id = v_item.id AND household_id = v_item.household_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF v_item.is_deleted THEN RETURN 'inactive_item'; END IF;
    IF v_batch.is_deleted IS DISTINCT FROM p_deleted THEN
      UPDATE public.batches SET is_deleted = p_deleted, deleted_at = v_deleted_at, deleted_with_item = false
        WHERE id = v_batch.id;
    END IF;
    RETURN 'ok';
  END IF;

  IF v_item.is_deleted = p_deleted THEN RETURN 'ok'; END IF;
  IF p_deleted AND EXISTS (SELECT 1 FROM public.medication_plans p
    JOIN public.medication_doses d ON d.plan_id = p.id AND d.household_id = p.household_id
    WHERE p.item_id = v_item.id AND p.household_id = v_item.household_id AND p.status = 'active'
      AND d.status = 'pending' AND d.scheduled_at > clock_timestamp()) THEN
    RETURN 'referenced';
  END IF;
  UPDATE public.items SET is_deleted = p_deleted, deleted_at = v_deleted_at WHERE id = v_item.id;
  IF p_deleted THEN
    UPDATE public.batches SET is_deleted = true, deleted_at = v_deleted_at, deleted_with_item = true
      WHERE item_id = v_item.id AND household_id = v_item.household_id AND NOT is_deleted;
  ELSE
    -- The legacy cascade used the same non-null timestamp for the parent and every child.
    UPDATE public.batches SET is_deleted = false, deleted_at = NULL, deleted_with_item = false
      WHERE item_id = v_item.id AND household_id = v_item.household_id AND is_deleted
        AND (deleted_with_item OR deleted_at = v_item.deleted_at);
  END IF;
  RETURN 'ok';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.purge_stock_deleted(p_item_id bigint DEFAULT NULL, p_batch_id bigint DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_item public.items%ROWTYPE;
  v_batch public.batches%ROWTYPE;
BEGIN
  IF (p_item_id IS NULL) = (p_batch_id IS NULL) THEN RETURN 'invalid_target'; END IF;
  SELECT i.* INTO v_item FROM public.items i
  WHERE i.id = COALESCE(p_item_id, (SELECT b.item_id FROM public.batches b
    WHERE b.id = p_batch_id AND b.household_id IN (SELECT public.my_household_ids())))
    AND i.household_id IN (SELECT public.my_household_ids()) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT * INTO v_batch FROM public.batches
      WHERE id = p_batch_id AND item_id = v_item.id AND household_id = v_item.household_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF NOT v_batch.is_deleted THEN RETURN 'not_in_trash'; END IF;
    DELETE FROM public.batches WHERE id = v_batch.id;
  ELSE
    IF NOT v_item.is_deleted THEN RETURN 'not_in_trash'; END IF;
    IF EXISTS (SELECT 1 FROM public.medication_plans WHERE item_id = v_item.id)
        OR EXISTS (SELECT 1 FROM public.drug_allergy_links WHERE item_id = v_item.id) THEN
      RETURN 'referenced';
    END IF;
    DELETE FROM public.batches WHERE item_id = v_item.id AND household_id = v_item.household_id;
    DELETE FROM public.items WHERE id = v_item.id;
  END IF;
  RETURN 'ok';
EXCEPTION WHEN foreign_key_violation THEN
  RETURN 'referenced';
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_stock_deleted(bigint, bigint, boolean), public.purge_stock_deleted(bigint, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_stock_deleted(bigint, bigint, boolean), public.purge_stock_deleted(bigint, bigint)
  TO authenticated;

-- Keep ordinary item and batch editing. Restrict state flags and physical deletion to the RPCs.
REVOKE INSERT, UPDATE, DELETE ON public.items, public.batches FROM PUBLIC, anon, authenticated;
GRANT INSERT (household_id, name, category, unit, brand, spec, barcode, pao_days, low_stock_threshold),
  UPDATE (name, category, unit, brand, spec, barcode, pao_days, low_stock_threshold) ON public.items TO authenticated;
GRANT INSERT (household_id, item_id, expiry_date, production_date, quantity, unit, status, opened_at, location_id, owner_name),
  UPDATE (expiry_date, production_date, quantity, unit, status, opened_at, location_id) ON public.batches TO authenticated;

DROP POLICY IF EXISTS items_all ON public.items;
DROP POLICY IF EXISTS items_read ON public.items;
DROP POLICY IF EXISTS items_create ON public.items;
DROP POLICY IF EXISTS items_edit ON public.items;
CREATE POLICY items_read ON public.items FOR SELECT TO authenticated USING (household_id IN (SELECT public.my_household_ids()));
CREATE POLICY items_create ON public.items FOR INSERT TO authenticated WITH CHECK (household_id IN (SELECT public.my_household_ids()));
CREATE POLICY items_edit ON public.items FOR UPDATE TO authenticated
  USING (NOT is_deleted AND household_id IN (SELECT public.my_household_ids()))
  WITH CHECK (NOT is_deleted AND household_id IN (SELECT public.my_household_ids()));

CREATE INDEX IF NOT EXISTS idx_batches_household_active_item ON public.batches (household_id, item_id)
  WHERE NOT is_deleted AND status = 'active';
COMMIT;
