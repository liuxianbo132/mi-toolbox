-- A single, idempotent intake writes the item, first batch and create record.
BEGIN;

CREATE TABLE IF NOT EXISTS public.stock_intake_requests (
  actor_id text NOT NULL,
  request_id uuid NOT NULL,
  household_id bigint NOT NULL,
  item_id bigint NOT NULL,
  batch_id bigint NOT NULL,
  submitted jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, request_id)
);
ALTER TABLE public.stock_intake_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_intake_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_stock_atomic(p_request_id uuid, p_item jsonb, p_first_batch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor text := auth.uid();
  v_me public.members%ROWTYPE;
  v_request public.stock_intake_requests%ROWTYPE;
  v_submitted jsonb := jsonb_build_object('item', p_item, 'batch', p_first_batch);
  v_item_id bigint;
  v_batch_id bigint;
  v_item_name text;
  v_category text;
  v_hid bigint;
  v_expiry date;
  v_production date;
  v_location_id bigint;
  v_quantity numeric;
  v_unit text;
  v_stock_threshold integer;
  v_pao_days integer;
BEGIN
  IF v_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_signed_in'); END IF;
  IF p_request_id IS NULL OR jsonb_typeof(p_item) IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_first_batch) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_stock');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_actor || ':' || p_request_id::text, 11));
  SELECT * INTO v_request FROM public.stock_intake_requests WHERE actor_id = v_actor AND request_id = p_request_id;
  IF FOUND THEN
    IF v_request.submitted IS DISTINCT FROM v_submitted THEN
      RETURN jsonb_build_object('ok', false, 'error', 'request_conflict');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.my_household_ids() h WHERE h = v_request.household_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_household');
    END IF;
    RETURN jsonb_build_object('ok', true, 'item_id', v_request.item_id, 'batch_id', v_request.batch_id);
  END IF;

  v_hid := (p_item->>'household_id')::bigint;
  SELECT * INTO v_me FROM public.members WHERE owner_id = v_actor AND household_id = v_hid AND left_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_household'); END IF;

  v_item_name := btrim(p_item->>'name');
  v_category := p_item->>'category';
  v_expiry := (p_first_batch->>'expiry_date')::date;
  v_production := (p_first_batch->>'production_date')::date;
  v_location_id := (p_first_batch->>'location_id')::bigint;
  v_quantity := (p_first_batch->>'quantity')::numeric;
  v_unit := btrim(p_first_batch->>'unit');
  v_stock_threshold := COALESCE((p_item->>'low_stock_threshold')::integer, 0);
  v_pao_days := COALESCE((p_item->>'pao_days')::integer, 0);

  IF COALESCE(v_item_name, '') = '' OR v_category IS NULL OR v_category NOT IN ('food', 'medicine', 'daily', 'other')
      OR v_stock_threshold NOT BETWEEN 0 AND 999 OR v_pao_days NOT BETWEEN 0 AND 3650
      OR v_expiry IS NULL OR NOT isfinite(v_expiry) OR (v_production IS NOT NULL AND (NOT isfinite(v_production) OR v_production > v_expiry))
      OR v_quantity IS NULL OR v_quantity <= 0 OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR COALESCE(v_unit, '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_stock');
  END IF;
  IF v_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.locations l
      WHERE l.id = v_location_id AND l.household_id = v_hid FOR SHARE) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_location');
  END IF;

  INSERT INTO public.items (household_id, name, category, unit, brand, spec, barcode, low_stock_threshold, pao_days)
    VALUES (v_hid, v_item_name, v_category, COALESCE(NULLIF(btrim(p_item->>'unit'), ''), v_unit),
      p_item->>'brand', p_item->>'spec', NULLIF(btrim(p_item->>'barcode'), ''), v_stock_threshold, v_pao_days)
    RETURNING id INTO v_item_id;
  INSERT INTO public.batches (household_id, item_id, expiry_date, production_date, quantity, unit, location_id, owner_id, owner_name)
    VALUES (v_hid, v_item_id, v_expiry, v_production, v_quantity, v_unit, v_location_id, v_actor, NULLIF(btrim(v_me.nickname), ''))
    RETURNING id INTO v_batch_id;
  INSERT INTO public.records (household_id, batch_id, action, quantity, note, owner_id, owner_name)
    VALUES (v_hid, v_batch_id, 'create', v_quantity, v_item_name, v_actor, NULLIF(btrim(v_me.nickname), ''));
  INSERT INTO public.stock_intake_requests (actor_id, request_id, household_id, item_id, batch_id, submitted)
    VALUES (v_actor, p_request_id, v_hid, v_item_id, v_batch_id, v_submitted);
  RETURN jsonb_build_object('ok', true, 'item_id', v_item_id, 'batch_id', v_batch_id);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('ok', false, 'error', 'invalid_stock');
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_stock_atomic(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_stock_atomic(uuid, jsonb, jsonb) TO authenticated;
REVOKE INSERT (household_id, name, category, unit, brand, spec, barcode, pao_days, low_stock_threshold)
  ON public.items FROM authenticated;

CREATE OR REPLACE FUNCTION public.check_medication_item_category()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF OLD.category = 'medicine' AND NEW.category IS DISTINCT FROM OLD.category AND EXISTS (
    SELECT 1 FROM public.medication_plans p JOIN public.medication_doses d ON d.plan_id = p.id AND d.household_id = p.household_id
    WHERE p.item_id = OLD.id AND p.household_id = OLD.household_id AND p.status = 'active'
      AND d.status = 'pending' AND d.scheduled_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'medication_item_in_use' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS check_medication_item_category ON public.items;
CREATE TRIGGER check_medication_item_category BEFORE UPDATE OF category ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.check_medication_item_category();
COMMIT;
