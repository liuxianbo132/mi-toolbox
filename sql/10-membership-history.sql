-- Membership changes preserve historical person IDs while revoking household access.
BEGIN;

ALTER TABLE public.members ADD COLUMN IF NOT EXISTS left_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_one_active_household ON public.members (owner_id) WHERE left_at IS NULL;

CREATE OR REPLACE FUNCTION public.my_household_ids()
RETURNS SETOF bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT household_id FROM public.members WHERE owner_id = auth.uid() AND left_at IS NULL;
$fn$;

DROP POLICY IF EXISTS members_all ON public.members;
DROP POLICY IF EXISTS members_read ON public.members;
DROP POLICY IF EXISTS members_rename ON public.members;
CREATE POLICY members_read ON public.members FOR SELECT TO authenticated
  USING (household_id IN (SELECT public.my_household_ids()));
CREATE POLICY members_rename ON public.members FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() AND left_at IS NULL)
  WITH CHECK (owner_id = auth.uid() AND left_at IS NULL);

DROP POLICY IF EXISTS allergies_manage ON public.allergies;
CREATE POLICY allergies_manage ON public.allergies FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m WHERE m.household_id = allergies.household_id
    AND m.owner_id = auth.uid() AND m.left_at IS NULL AND (m.id = allergies.member_id OR m.role = 'owner')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.members m WHERE m.household_id = allergies.household_id
    AND m.owner_id = auth.uid() AND m.left_at IS NULL AND (m.id = allergies.member_id OR m.role = 'owner'))
    AND EXISTS (SELECT 1 FROM public.members subject WHERE subject.id = allergies.member_id
      AND subject.household_id = allergies.household_id AND subject.left_at IS NULL));

CREATE OR REPLACE FUNCTION public.join_household(p_code text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_hid bigint;
BEGIN
  IF v_uid IS NULL THEN RETURN 'not_signed_in'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid, 10));
  IF EXISTS (SELECT 1 FROM public.members WHERE owner_id = v_uid AND left_at IS NULL) THEN RETURN 'already_joined'; END IF;
  SELECT id INTO v_hid FROM public.households WHERE invite_code = upper(btrim(p_code));
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  INSERT INTO public.members (household_id, owner_id, role) VALUES (v_hid, v_uid, 'member')
    ON CONFLICT (household_id, owner_id) DO UPDATE SET left_at = NULL, joined_at = clock_timestamp();
  RETURN 'ok';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.create_household(p_name text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_hid bigint;
  v_code text;
BEGIN
  IF v_uid IS NULL THEN RETURN 'not_signed_in'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid, 10));
  IF EXISTS (SELECT 1 FROM public.members WHERE owner_id = v_uid AND left_at IS NULL) THEN RETURN 'already_joined'; END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 40 THEN RETURN 'invalid_name'; END IF;

  FOR attempt IN 1..5 LOOP
    SELECT 'HB' || string_agg(substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', floor(random() * 36)::int + 1, 1), '')
      INTO v_code FROM generate_series(1, 6);
    INSERT INTO public.households (owner_id, name, invite_code) VALUES (v_uid, btrim(p_name), v_code)
      ON CONFLICT (invite_code) DO NOTHING RETURNING id INTO v_hid;
    EXIT WHEN v_hid IS NOT NULL;
  END LOOP;
  IF v_hid IS NULL THEN RETURN 'invite_unavailable'; END IF;

  INSERT INTO public.members (household_id, owner_id, role) VALUES (v_hid, v_uid, 'owner');
  RETURN 'ok';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.archive_household_member(p_member_id bigint, p_household_id bigint)
RETURNS text LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE
  v_now timestamptz;
BEGIN
  PERFORM 1 FROM public.members WHERE id = p_member_id AND household_id = p_household_id
    AND role = 'member' AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  v_now := clock_timestamp();
  UPDATE public.members SET left_at = v_now
    WHERE id = p_member_id AND household_id = p_household_id AND role = 'member' AND left_at IS NULL;

  UPDATE public.medication_plans SET status = 'cancelled', updated_at = v_now
    WHERE member_id = p_member_id AND household_id = p_household_id AND status = 'active';
  DELETE FROM public.medication_doses d USING public.medication_plans p
    WHERE d.plan_id = p.id AND p.member_id = p_member_id AND p.household_id = p_household_id
      AND p.status = 'cancelled' AND d.household_id = p_household_id AND d.status = 'pending' AND d.scheduled_at > v_now;
  RETURN 'ok';
END;
$fn$;
REVOKE ALL ON FUNCTION public.archive_household_member(bigint, bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.leave_household()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_member public.members%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN 'not_signed_in'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid, 10));
  SELECT * INTO v_member FROM public.members WHERE owner_id = v_uid AND left_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_member.role = 'owner' THEN RETURN 'owner_cannot_leave'; END IF;
  RETURN public.archive_household_member(v_member.id, v_member.household_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.remove_member(p_member_id bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_hid bigint;
  v_target public.members%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN 'not_signed_in'; END IF;
  SELECT household_id INTO v_hid FROM public.members WHERE owner_id = v_uid AND role = 'owner' AND left_at IS NULL;
  IF NOT FOUND THEN RETURN 'forbidden'; END IF;
  SELECT * INTO v_target FROM public.members WHERE id = p_member_id AND household_id = v_hid AND left_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_target.role <> 'member' THEN RETURN 'forbidden'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_target.owner_id, 10));
  IF NOT EXISTS (SELECT 1 FROM public.members WHERE id = v_target.id AND left_at IS NULL
    AND joined_at IS NOT DISTINCT FROM v_target.joined_at) THEN RETURN 'not_found'; END IF;
  RETURN public.archive_household_member(v_target.id, v_hid);
END;
$fn$;

REVOKE ALL ON FUNCTION public.join_household(text), public.create_household(text), public.leave_household(), public.remove_member(bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_household(text), public.create_household(text), public.leave_household(), public.remove_member(bigint)
  TO authenticated;

-- Runs under the same member row lock as archival and protects direct migration-owned inserts too.
CREATE OR REPLACE FUNCTION public.check_new_medication_recipient()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  PERFORM 1 FROM public.members m WHERE m.id = NEW.member_id
    AND m.household_id = NEW.household_id AND m.left_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan recipient needs an active membership' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS check_new_medication_recipient ON public.medication_plans;
CREATE TRIGGER check_new_medication_recipient BEFORE INSERT OR UPDATE OF member_id, household_id ON public.medication_plans
  FOR EACH ROW EXECUTE FUNCTION public.check_new_medication_recipient();
COMMIT;
