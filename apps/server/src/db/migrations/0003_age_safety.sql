-- Age safety (CLAUDE.md invariants 7 and 10, PLAN.md Phase 1).
-- vc_age_years / vc_band are the SQL twins of ageOn() / bandFor() in packages/shared/src/age.ts;
-- apps/server/test/safety/age-sql-parity.test.ts checks that they agree.

-- NULL (no age) when p_on is before p_birth, like ageOn() throwing; vc_band() is then NULL too.
CREATE FUNCTION vc_age_years(p_birth date, p_on date) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT CASE WHEN p_on < p_birth THEN NULL ELSE extract(year FROM age(p_on, p_birth))::integer END $$;
--> statement-breakpoint
CREATE FUNCTION vc_band(p_birth date, p_on date) RETURNS band
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT CASE
      WHEN p_birth IS NULL THEN NULL
      WHEN vc_age_years(p_birth, p_on) >= 18 THEN 'adult'::band
      WHEN vc_age_years(p_birth, p_on) >= 14 THEN 'u18'::band
      ELSE NULL
    END
  $$;
--> statement-breakpoint
-- Ages use the UTC calendar date (Q15).
CREATE FUNCTION vc_today() RETURNS date
  LANGUAGE sql STABLE
  AS $$ SELECT (now() AT TIME ZONE 'UTC')::date $$;
--> statement-breakpoint

-- birth_date is write-once. The only exception is admin_set_birth_date(), which runs as the table
-- owner and sets a transaction-local flag. The app role can set the flag too, but it is never the
-- owner, so the flag alone is not enough.
CREATE FUNCTION users_birth_date_write_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF OLD.birth_date IS NOT NULL AND NEW.birth_date IS DISTINCT FROM OLD.birth_date THEN
      IF coalesce(current_setting('samesync.birth_date_override', true), '') = 'on'
         AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.users'::regclass)
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'birth_date is write-once; only admin_set_birth_date() can change it'
        USING ERRCODE = 'SS001';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER users_10_birth_date_write_once
  BEFORE UPDATE OF birth_date ON users
  FOR EACH ROW EXECUTE FUNCTION users_birth_date_write_once();
--> statement-breakpoint

-- age_band is a cache, re-derived from birth_date on every write, so CHECKs on it (mode, username)
-- always see the live band at write time. A stale cache only appears between writes (e.g. after an
-- 18th birthday) and Phase 2's age-transition job reconciles it.
CREATE FUNCTION users_derive_age_band() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    NEW.age_band := vc_band(NEW.birth_date, vc_today());
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER users_20_derive_age_band
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_derive_age_band();
--> statement-breakpoint

-- The only way to change a birth date after it is set. Requires a reason, writes admin_actions,
-- and makes the profile consistent with the new band:
--   u18   → friends mode, no dating fields, no username;
--   < 14  → ineligible, all profile data removed (Q16);
--   was ineligible and now ≥ 14 → back to onboarding.
CREATE FUNCTION admin_set_birth_date(p_user_id uuid, p_new_date date, p_admin_tg_id bigint, p_reason text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_old users%ROWTYPE;
    v_today date := vc_today();
    v_band band;
  BEGIN
    IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
      RAISE EXCEPTION 'admin_set_birth_date: a reason is required' USING ERRCODE = 'SS002';
    END IF;
    IF p_admin_tg_id IS NULL OR p_admin_tg_id <= 0 THEN
      RAISE EXCEPTION 'admin_set_birth_date: the admin telegram id is required' USING ERRCODE = 'SS002';
    END IF;
    IF p_new_date IS NULL OR p_new_date > v_today OR vc_age_years(p_new_date, v_today) > 120 THEN
      RAISE EXCEPTION 'admin_set_birth_date: implausible birth date' USING ERRCODE = 'SS002';
    END IF;

    SELECT * INTO v_old FROM users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'admin_set_birth_date: user not found' USING ERRCODE = 'SS003';
    END IF;
    v_band := vc_band(p_new_date, v_today);

    PERFORM set_config('samesync.birth_date_override', 'on', true);
    UPDATE users SET
      birth_date = p_new_date,
      username = CASE WHEN v_band = 'adult' THEN username END,
      mode = CASE WHEN v_band = 'adult' THEN mode WHEN v_band = 'u18' THEN 'friends'::mode END,
      gender = CASE WHEN v_band = 'adult' THEN gender END,
      seeking = CASE WHEN v_band = 'adult' THEN seeking END,
      timezone = CASE WHEN v_band IS NOT NULL THEN timezone END,
      onboarded_at = CASE WHEN v_band IS NOT NULL THEN onboarded_at END,
      status = CASE
        WHEN v_band IS NULL THEN 'ineligible'::user_status
        WHEN status = 'ineligible' THEN 'onboarding'::user_status
        ELSE status
      END
    WHERE id = p_user_id;
    PERFORM set_config('samesync.birth_date_override', 'off', true);

    IF v_band IS NULL THEN
      DELETE FROM answers WHERE user_id = p_user_id;
      DELETE FROM user_interests WHERE user_id = p_user_id;
    END IF;

    INSERT INTO admin_actions (admin_telegram_id, action, target_user_id, before, after, reason)
    SELECT p_admin_tg_id, 'set_birth_date', p_user_id,
      jsonb_build_object('birth_date', v_old.birth_date, 'age_band', v_old.age_band, 'status', v_old.status),
      jsonb_build_object('birth_date', u.birth_date, 'age_band', u.age_band, 'status', u.status),
      p_reason
    FROM users u WHERE u.id = p_user_id;
  END
  $$;
--> statement-breakpoint
-- Not callable by the app role in Phase 1 (no admin command yet; Phase 5 grants it deliberately).
REVOKE ALL ON FUNCTION admin_set_birth_date(uuid, date, bigint, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION vc_age_years(date, date), vc_band(date, date), vc_today() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION vc_age_years(date, date), vc_band(date, date), vc_today() TO samesync_app;
--> statement-breakpoint

-- Least privilege for the new tables.
GRANT SELECT ON content_releases, questions, interest_categories, interest_items, dating_options TO samesync_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON answers TO samesync_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON user_interests TO samesync_app;
--> statement-breakpoint
-- admin_actions is append-only for the app role (PLAN.md §3 layer 6).
GRANT INSERT ON admin_actions TO samesync_app;
