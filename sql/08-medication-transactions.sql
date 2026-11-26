-- Apply after 07, in one transaction. See docs/briefs/v3-delivery.md for rollout and recovery.
BEGIN;

ALTER TABLE public.medication_plans
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS left_at timestamptz;

CREATE TABLE IF NOT EXISTS public.medication_plan_requests (
  actor_id text NOT NULL,
  request_id uuid NOT NULL,
  plan_id bigint NOT NULL REFERENCES public.medication_plans(id),
  submitted jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, request_id)
);
ALTER TABLE public.medication_plan_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.medication_plan_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.has_registered_medication_block(
  p_household_id bigint, p_item_id bigint, p_member_id bigint
)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.allergies a
    JOIN public.drug_allergy_links l ON btrim(l.allergen) = btrim(a.allergen)
    WHERE a.household_id = p_household_id AND a.member_id = p_member_id
      AND l.household_id = p_household_id AND l.item_id = p_item_id
      AND l.kind = 'forbidden' AND btrim(a.allergen) <> ''
  );
$fn$;
REVOKE ALL ON FUNCTION public.has_registered_medication_block(bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.save_med_plan_atomic(
  p_plan_id bigint,
  p_request_id uuid,
  p_fields jsonb,
  p_rows jsonb,
  p_expected_updated_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor text := auth.uid();
  v_plan public.medication_plans%ROWTYPE;
  v_request public.medication_plan_requests%ROWTYPE;
  v_hid bigint;
  v_item_id bigint;
  v_member_id bigint;
  v_start date;
  v_end date;
  v_freq text;
  v_times jsonb;
  v_threshold integer;
  v_now timestamptz;
  v_slots timestamptz[];
  v_submitted jsonb := jsonb_build_object('plan_id', p_plan_id, 'fields', p_fields, 'rows', p_rows);
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_signed_in');
  END IF;
  IF p_request_id IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_schedule');
  END IF;

  -- A timeout can follow a commit. Serialize retries by authenticated actor and request ID.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_actor || ':' || p_request_id::text, 8));
  SELECT * INTO v_request FROM public.medication_plan_requests
    WHERE actor_id = v_actor AND request_id = p_request_id;
  IF FOUND THEN
    IF v_request.submitted IS DISTINCT FROM v_submitted THEN
      RETURN jsonb_build_object('ok', false, 'error', 'request_conflict');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.medication_plans p WHERE p.id = v_request.plan_id
        AND p.household_id IN (SELECT public.my_household_ids())
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
    RETURN jsonb_build_object('ok', true, 'plan_id', v_request.plan_id);
  END IF;

  v_item_id := (p_fields->>'item_id')::bigint;
  v_member_id := (p_fields->>'member_id')::bigint;
  v_start := (p_fields->>'start_date')::date;
  v_end := (p_fields->>'end_date')::date;
  v_freq := p_fields->>'freq';
  v_times := p_fields->'times';
  v_threshold := (p_fields->>'miss_threshold_minutes')::integer;
  IF v_start IS NULL OR v_end IS NULL OR NOT isfinite(v_start) OR NOT isfinite(v_end)
      OR v_end < v_start OR v_end - v_start >= 180
      OR v_freq IS NULL OR v_freq NOT IN ('daily', 'alternate_day')
      OR v_threshold IS NULL OR v_threshold NOT BETWEEN 10 AND 120 OR v_threshold % 5 <> 0
      OR jsonb_typeof(v_times) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_schedule');
  END IF;
  IF jsonb_array_length(v_times) NOT BETWEEN 1 AND 48
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_times) AS t(value)
        WHERE t.value IS NULL OR t.value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      OR (SELECT count(DISTINCT t.value) FROM jsonb_array_elements_text(v_times) AS t(value)) <> jsonb_array_length(v_times)
      OR jsonb_array_length(p_rows) > (v_end - v_start + 1) * jsonb_array_length(v_times)
      OR (p_plan_id IS NULL AND jsonb_array_length(p_rows) = 0) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_schedule');
  END IF;

  -- Keep the device-local instants chosen by the existing scheduler. Bounds allow all civil offsets.
  SELECT ARRAY(SELECT (r.value->>'scheduled_at')::timestamptz FROM jsonb_array_elements(p_rows) AS r(value)) INTO v_slots;
  IF EXISTS (SELECT 1 FROM unnest(v_slots) AS s(slot)
    WHERE s.slot IS NULL OR NOT isfinite(s.slot)
      OR s.slot < (v_start::timestamp AT TIME ZONE 'UTC') - interval '14 hours'
      OR s.slot >= ((v_end + 1)::timestamp AT TIME ZONE 'UTC') + interval '14 hours'
      OR s.slot <> date_trunc('minute', s.slot)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_schedule');
  END IF;

  SELECT m.household_id INTO v_hid
  FROM public.members m JOIN public.items i ON i.household_id = m.household_id
  WHERE m.id = v_member_id AND m.left_at IS NULL AND i.id = v_item_id AND i.category = 'medicine' AND NOT i.is_deleted
    AND m.household_id IN (SELECT public.my_household_ids())
  FOR SHARE OF m, i;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_plan_target');
  END IF;

  IF p_plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM public.medication_plans
      WHERE id = p_plan_id AND household_id = v_hid FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
    IF v_plan.status <> 'active' OR v_plan.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RETURN jsonb_build_object('ok', false, 'error', 'schedule_changed');
    END IF;
    IF v_plan.item_id <> v_item_id OR v_plan.member_id <> v_member_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_plan_target');
    END IF;
  END IF;
  IF public.has_registered_medication_block(v_hid, v_item_id, v_member_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden_allergy');
  END IF;

  v_now := clock_timestamp();
  IF p_plan_id IS NULL THEN
    INSERT INTO public.medication_plans
      (household_id, item_id, member_id, times, freq, start_date, end_date, miss_threshold_minutes, updated_at)
    VALUES (v_hid, v_item_id, v_member_id, v_times, v_freq, v_start, v_end, v_threshold, v_now)
    RETURNING * INTO v_plan;
  ELSE
    UPDATE public.medication_plans SET times = v_times, freq = v_freq, start_date = v_start, end_date = v_end,
      miss_threshold_minutes = v_threshold, updated_at = v_now WHERE id = v_plan.id;
    DELETE FROM public.medication_doses WHERE plan_id = v_plan.id AND household_id = v_hid
      AND status = 'pending' AND scheduled_at > v_now;
  END IF;

  INSERT INTO public.medication_doses (household_id, plan_id, scheduled_at)
  SELECT DISTINCT v_hid, v_plan.id, s.slot FROM unnest(v_slots) AS s(slot)
    WHERE (p_plan_id IS NULL OR s.slot > v_now)
      AND NOT EXISTS (SELECT 1 FROM public.medication_doses d
        WHERE d.plan_id = v_plan.id AND d.household_id = v_hid AND d.scheduled_at = s.slot);

  INSERT INTO public.medication_plan_requests (actor_id, request_id, plan_id, submitted)
    VALUES (v_actor, p_request_id, v_plan.id, v_submitted);
  RETURN jsonb_build_object('ok', true, 'plan_id', v_plan.id);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('ok', false, 'error', 'invalid_schedule');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.transition_dose(p_dose_id bigint, p_target_status text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_plan public.medication_plans%ROWTYPE;
  v_dose public.medication_doses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RETURN 'not_signed_in'; END IF;
  IF p_target_status IS NULL OR p_target_status NOT IN ('taken', 'missed') THEN RETURN 'invalid_transition'; END IF;

  SELECT p.* INTO v_plan FROM public.medication_plans p
    JOIN public.medication_doses d ON d.plan_id = p.id AND d.household_id = p.household_id
    WHERE d.id = p_dose_id AND p.household_id IN (SELECT public.my_household_ids())
    FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  SELECT * INTO v_dose FROM public.medication_doses
    WHERE id = p_dose_id AND plan_id = v_plan.id AND household_id = v_plan.household_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_dose.status = p_target_status THEN RETURN 'ok'; END IF;

  IF p_target_status = 'taken' AND v_dose.status = 'pending' THEN
    IF (v_plan.status = 'cancelled' AND v_dose.scheduled_at > clock_timestamp())
        OR NOT EXISTS (SELECT 1 FROM public.items i JOIN public.members m ON m.household_id = i.household_id
          WHERE i.id = v_plan.item_id AND m.id = v_plan.member_id AND i.household_id = v_plan.household_id
            AND i.category = 'medicine' AND NOT i.is_deleted AND m.left_at IS NULL) THEN
      RETURN 'schedule_changed';
    END IF;
    IF public.has_registered_medication_block(v_plan.household_id, v_plan.item_id, v_plan.member_id) THEN RETURN 'forbidden_allergy'; END IF;
  ELSIF NOT (p_target_status = 'missed' AND v_dose.status = 'taken') THEN
    RETURN 'invalid_transition';
  END IF;

  UPDATE public.medication_doses SET status = p_target_status,
    confirmed_at = CASE WHEN p_target_status = 'taken' THEN clock_timestamp() ELSE NULL END
    WHERE id = v_dose.id;
  RETURN 'ok';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cancel_plan_atomic(p_plan_id bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_plan public.medication_plans%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RETURN 'not_signed_in'; END IF;
  SELECT * INTO v_plan FROM public.medication_plans
    WHERE id = p_plan_id AND household_id IN (SELECT public.my_household_ids()) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_plan.status NOT IN ('active', 'cancelled') THEN RETURN 'schedule_changed'; END IF;

  v_now := clock_timestamp();
  IF v_plan.status = 'active' THEN
    UPDATE public.medication_plans SET status = 'cancelled', updated_at = v_now WHERE id = v_plan.id;
  END IF;
  DELETE FROM public.medication_doses WHERE plan_id = v_plan.id AND household_id = v_plan.household_id
    AND status = 'pending' AND scheduled_at > v_now;
  RETURN 'ok';
END;
$fn$;

REVOKE ALL ON FUNCTION public.replace_future_doses(bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_med_plan_atomic(bigint, uuid, jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_dose(bigint, text), public.cancel_plan_atomic(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_med_plan_atomic(bigint, uuid, jsonb, jsonb, timestamptz),
  public.transition_dose(bigint, text), public.cancel_plan_atomic(bigint) TO authenticated;

-- The scheduled job retains the migration role's table privileges.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.medication_plans, public.medication_doses FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_doses_household_scheduled ON public.medication_doses (household_id, scheduled_at);
COMMIT;
