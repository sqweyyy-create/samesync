-- Matching safety (CLAUDE.md invariants 1, 2, 4, 5, 8 and 9; PLAN.md §3 layers 2 and 3).
-- Every check re-derives both users' bands from birth_date at write time. users.age_band is a
-- cache and is never the basis of a decision here.
-- The functions pin search_path with pg_temp last, so a temporary table can't shadow users, blocks,
-- matches or outbox.

-- SQL twin of birthDatesWithinYears() in packages/shared/src/age.ts (Q14): the younger person is
-- born no later than the older one's p_years-th birthday, i.e. the older one had not yet turned
-- p_years the day before. apps/server/test/safety/age-sql-parity.test.ts checks that both agree.
CREATE FUNCTION vc_within_years(p_a date, p_b date, p_years integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT least(p_a, p_b) = greatest(p_a, p_b)
        OR vc_age_years(least(p_a, p_b), greatest(p_a, p_b) - 1) < p_years
  $$;
--> statement-breakpoint

-- A match can only be created between two users who, right now, are both active, in the match's
-- band (from birth_date), locale and mode, not blocked, and (u18) at most 2 calendar years apart or
-- (dating) compatible in both directions. The message names the failed rule.
CREATE FUNCTION matches_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    a users%ROWTYPE;
    b users%ROWTYPE;
    v_today date := vc_today();
    v_band_a band;
    v_band_b band;
    v_age_a integer;
    v_age_b integer;
  BEGIN
    -- Share-lock both users until this transaction ends: a concurrent freeze or birth-date
    -- correction either waits for this match (and then closes it) or is already visible here.
    SELECT * INTO a FROM users WHERE id = NEW.user_a_id FOR SHARE;
    SELECT * INTO b FROM users WHERE id = NEW.user_b_id FOR SHARE;
    IF a.id IS NULL OR b.id IS NULL THEN
      RAISE EXCEPTION 'match rejected: unknown_user' USING ERRCODE = 'SS010';
    END IF;
    IF NEW.status <> 'pending_game' THEN
      RAISE EXCEPTION 'match rejected: bad_initial_status' USING ERRCODE = 'SS010';
    END IF;
    -- Frozen, deleted, waitlisted, onboarding and ineligible users are never matched.
    IF a.status <> 'active' OR b.status <> 'active' THEN
      RAISE EXCEPTION 'match rejected: not_active' USING ERRCODE = 'SS010';
    END IF;

    v_band_a := vc_band(a.birth_date, v_today);
    v_band_b := vc_band(b.birth_date, v_today);
    IF v_band_a IS NULL OR v_band_b IS NULL OR v_band_a <> v_band_b OR v_band_a <> NEW.band THEN
      RAISE EXCEPTION 'match rejected: band' USING ERRCODE = 'SS010';
    END IF;
    IF a.locale <> NEW.locale OR b.locale <> NEW.locale THEN
      RAISE EXCEPTION 'match rejected: locale' USING ERRCODE = 'SS010';
    END IF;
    IF a.mode IS DISTINCT FROM NEW.mode OR b.mode IS DISTINCT FROM NEW.mode THEN
      RAISE EXCEPTION 'match rejected: mode' USING ERRCODE = 'SS010';
    END IF;

    IF NEW.band = 'u18' THEN
      IF NEW.mode <> 'friends' THEN
        RAISE EXCEPTION 'match rejected: u18_mode' USING ERRCODE = 'SS010';
      END IF;
      IF NOT vc_within_years(a.birth_date, b.birth_date, 2) THEN
        RAISE EXCEPTION 'match rejected: u18_age_gap' USING ERRCODE = 'SS010';
      END IF;
    END IF;

    IF NEW.mode = 'dating' THEN
      IF NOT coalesce(a.gender = ANY (b.seeking) AND b.gender = ANY (a.seeking), false) THEN
        RAISE EXCEPTION 'match rejected: dating_preference' USING ERRCODE = 'SS010';
      END IF;
      v_age_a := vc_age_years(a.birth_date, v_today);
      v_age_b := vc_age_years(b.birth_date, v_today);
      IF NOT coalesce(
        v_age_b BETWEEN a.dating_age_min AND a.dating_age_max
        AND v_age_a BETWEEN b.dating_age_min AND b.dating_age_max,
        false
      ) THEN
        RAISE EXCEPTION 'match rejected: dating_age_range' USING ERRCODE = 'SS010';
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1 FROM blocks
      WHERE (blocker_id = a.id AND blocked_id = b.id) OR (blocker_id = b.id AND blocked_id = a.id)
    ) THEN
      RAISE EXCEPTION 'match rejected: blocked' USING ERRCODE = 'SS010';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER matches_10_guard_insert
  BEFORE INSERT ON matches
  FOR EACH ROW EXECUTE FUNCTION matches_guard_insert();
--> statement-breakpoint

-- Who is matched, in which pool, and what they were shown can never change, and a closed match
-- stays closed. Without this, an UPDATE could move a match across bands after the insert check.
CREATE FUNCTION matches_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF (NEW.id, NEW.user_a_id, NEW.user_b_id, NEW.band, NEW.locale, NEW.mode, NEW.run_id,
        NEW.tier, NEW.score, NEW.teaser, NEW.alias_a, NEW.alias_b, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.user_a_id, OLD.user_b_id, OLD.band, OLD.locale, OLD.mode, OLD.run_id,
        OLD.tier, OLD.score, OLD.teaser, OLD.alias_a, OLD.alias_b, OLD.created_at)
    THEN
      RAISE EXCEPTION 'matches: the pair, the pool and the teaser of a match are immutable'
        USING ERRCODE = 'SS011';
    END IF;
    IF OLD.status IN ('expired', 'closed')
       AND (NEW.status, NEW.close_reason, NEW.closed_at)
           IS DISTINCT FROM (OLD.status, OLD.close_reason, OLD.closed_at)
    THEN
      RAISE EXCEPTION 'matches: a closed match stays closed' USING ERRCODE = 'SS011';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER matches_10_guard_update
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION matches_guard_update();
--> statement-breakpoint

-- Invariant 4: when a user's band or birth date changes, or the user is frozen or deleted, the
-- same transaction closes all their open matches and cancels the pending notifications of the
-- user and of those matches. SECURITY DEFINER, so it works whoever updates the user.
-- age_band is re-derived by users_20_derive_age_band before this runs, so an 18th birthday shows up
-- here on the first write after it (the hourly age-transition job makes that write).
CREATE FUNCTION users_close_matches_on_state_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_reason match_close_reason;
  BEGIN
    IF NEW.age_band IS DISTINCT FROM OLD.age_band THEN
      v_reason := 'band_change';
    ELSIF NEW.birth_date IS DISTINCT FROM OLD.birth_date THEN
      -- A correction inside the same band can still break the u18 two-year rule.
      v_reason := 'admin';
    ELSIF NEW.status = 'frozen' THEN
      v_reason := 'frozen';
    ELSIF NEW.status = 'deleted' THEN
      v_reason := 'deleted';
    ELSE
      RETURN NULL;
    END IF;

    WITH closed AS (
      UPDATE matches SET status = 'closed', close_reason = v_reason, closed_at = now()
      WHERE (user_a_id = NEW.id OR user_b_id = NEW.id)
        AND status IN ('pending_game', 'results_ready', 'active')
      RETURNING id
    )
    UPDATE outbox SET status = 'cancelled', cancel_reason = v_reason::text
    WHERE status = 'pending'
      AND (user_id = NEW.id OR match_id IN (SELECT id FROM closed));
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
-- Not "UPDATE OF …": age_band is changed by a BEFORE trigger, which a column list would miss.
CREATE TRIGGER users_90_close_matches
  AFTER UPDATE ON users
  FOR EACH ROW
  WHEN (
    OLD.age_band IS DISTINCT FROM NEW.age_band
    OR OLD.birth_date IS DISTINCT FROM NEW.birth_date
    OR (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('frozen', 'deleted'))
  )
  EXECUTE FUNCTION users_close_matches_on_state_change();
--> statement-breakpoint

REVOKE ALL ON FUNCTION vc_within_years(date, date, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION vc_within_years(date, date, integer) TO samesync_app;
--> statement-breakpoint
-- Trigger functions are only ever run by their triggers.
REVOKE ALL ON FUNCTION matches_guard_insert(), matches_guard_update(), users_close_matches_on_state_change() FROM PUBLIC;
--> statement-breakpoint

-- Least privilege for the new tables. The app role never deletes a match, a run, a block or an
-- outbox row, and can change only the lifecycle columns of a match.
GRANT SELECT, INSERT ON matches TO samesync_app;
--> statement-breakpoint
GRANT UPDATE (status, close_reason, closed_at, game_deadline_at, results_ready_at, chat_deadline_at, first_message_at)
  ON matches TO samesync_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON match_runs, outbox TO samesync_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON games TO samesync_app;
--> statement-breakpoint
-- Blocks are created from Phase 5; until then the app only reads them.
GRANT SELECT ON blocks TO samesync_app;
--> statement-breakpoint
-- Derived statistics, replaced as a whole by every matching run.
GRANT SELECT, INSERT, DELETE ON feature_stats TO samesync_app;
