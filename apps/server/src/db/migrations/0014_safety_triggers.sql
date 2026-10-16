-- Safety and admin tooling (CLAUDE.md invariants 2, 4, 5, 7, 9 and 10; PLAN.md Phase 5, §3
-- layers 2, 3 and 6). Like the functions of migrations 0005, 0007 and 0010, these pin
-- search_path with pg_temp last.

-- 1. The u18 chat opens, behind the contact filter. The same function as in migration 0010 with
-- one rule removed: the database no longer refuses every message of a u18 match
-- ("u18_chat_closed"). Every u18 message still has to pass the contact filter before it is
-- relayed (invariant 5): the relay's screening hook refuses without a filter and on any error of
-- it (fail closed), and `CHAT_BANDS` in domain/chat/params.ts names the bands that can chat. This
-- migration is the third of the three things the Phase 4 notes said Phase 5 has to lift. Nothing
-- here looks at U18_POOL_ENABLED: while the u18 pool is off, u18 users are waitlisted, not active,
-- and the `not_active` rule below refuses them anyway.
CREATE OR REPLACE FUNCTION messages_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    m matches%ROWTYPE;
    a users%ROWTYPE;
    b users%ROWTYPE;
    v_today date := vc_today();
  BEGIN
    -- Lock the match until this transaction ends: a concurrent close or expiry has either
    -- finished, and is visible here, or waits for this message.
    SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR SHARE;
    IF m.id IS NULL THEN
      RAISE EXCEPTION 'message rejected: unknown_match' USING ERRCODE = 'SS030';
    END IF;
    IF NEW.sender_id IS DISTINCT FROM m.user_a_id AND NEW.sender_id IS DISTINCT FROM m.user_b_id THEN
      RAISE EXCEPTION 'message rejected: not_participant' USING ERRCODE = 'SS030';
    END IF;
    IF m.status NOT IN ('results_ready', 'active') THEN
      RAISE EXCEPTION 'message rejected: chat_not_open' USING ERRCODE = 'SS030';
    END IF;
    -- The users are read without a lock: a freeze or birth-date correction that commits after
    -- this check closes the match itself (the state-change trigger), and the relay reads both
    -- users again right before it calls Telegram.
    SELECT * INTO a FROM users WHERE id = m.user_a_id;
    SELECT * INTO b FROM users WHERE id = m.user_b_id;
    -- Frozen, deleted and every other non-active status: fail closed.
    IF a.status IS DISTINCT FROM 'active' OR b.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'message rejected: not_active' USING ERRCODE = 'SS030';
    END IF;
    IF vc_band(a.birth_date, v_today) IS DISTINCT FROM m.band
       OR vc_band(b.birth_date, v_today) IS DISTINCT FROM m.band THEN
      RAISE EXCEPTION 'message rejected: band' USING ERRCODE = 'SS030';
    END IF;
    IF EXISTS (
      SELECT 1 FROM blocks
      WHERE (blocker_id = a.id AND blocked_id = b.id) OR (blocker_id = b.id AND blocked_id = a.id)
    ) THEN
      RAISE EXCEPTION 'message rejected: blocked' USING ERRCODE = 'SS030';
    END IF;
    -- A new message has not reached anyone yet.
    IF NEW.delivered_at IS NOT NULL OR NEW.recipient_tg_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'message rejected: already_delivered' USING ERRCODE = 'SS030';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint

-- 2. A report is about the two people of one match: the reported person is a participant, and
-- the reporter is the other participant, or nobody (a system report from the contact filter's
-- escalation). A report starts open. The message names the failed rule.
CREATE FUNCTION reports_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    m matches%ROWTYPE;
    v_other uuid;
  BEGIN
    SELECT * INTO m FROM matches WHERE id = NEW.match_id;
    IF m.id IS NULL THEN
      RAISE EXCEPTION 'report rejected: unknown_match' USING ERRCODE = 'SS050';
    END IF;
    IF NEW.reported_id IS DISTINCT FROM m.user_a_id AND NEW.reported_id IS DISTINCT FROM m.user_b_id THEN
      RAISE EXCEPTION 'report rejected: reported_not_participant' USING ERRCODE = 'SS050';
    END IF;
    v_other := CASE WHEN NEW.reported_id = m.user_a_id THEN m.user_b_id ELSE m.user_a_id END;
    IF NEW.reporter_id IS NOT NULL AND NEW.reporter_id IS DISTINCT FROM v_other THEN
      RAISE EXCEPTION 'report rejected: reporter_not_participant' USING ERRCODE = 'SS050';
    END IF;
    IF NEW.status <> 'open' OR NEW.resolved_at IS NOT NULL OR NEW.resolved_by IS NOT NULL THEN
      RAISE EXCEPTION 'report rejected: not_open' USING ERRCODE = 'SS050';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER reports_10_guard_insert
  BEFORE INSERT ON reports
  FOR EACH ROW EXECUTE FUNCTION reports_guard_insert();
--> statement-breakpoint

-- Who reported whom, in which match, why and when never changes. The evidence can only be
-- removed (the retention purge, Q20). A report is resolved once: afterwards its status, who
-- resolved it and when stay as they are.
CREATE FUNCTION reports_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF (NEW.id, NEW.seq, NEW.reporter_id, NEW.reported_id, NEW.match_id, NEW.reason, NEW.note, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.seq, OLD.reporter_id, OLD.reported_id, OLD.match_id, OLD.reason, OLD.note, OLD.created_at)
    THEN
      RAISE EXCEPTION 'reports: who reported whom, why and when is immutable' USING ERRCODE = 'SS051';
    END IF;
    IF NEW.evidence IS DISTINCT FROM OLD.evidence AND NEW.evidence IS NOT NULL THEN
      RAISE EXCEPTION 'reports: the evidence of a report can only be removed' USING ERRCODE = 'SS051';
    END IF;
    IF OLD.status <> 'open'
       AND (NEW.status, NEW.resolved_by, NEW.resolved_at)
           IS DISTINCT FROM (OLD.status, OLD.resolved_by, OLD.resolved_at)
    THEN
      RAISE EXCEPTION 'reports: a resolved report stays resolved' USING ERRCODE = 'SS051';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER reports_10_guard_update
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION reports_guard_update();
--> statement-breakpoint

-- 3. A block names a match only if both people are in it. (That the two differ is a CHECK.)
CREATE FUNCTION blocks_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    m matches%ROWTYPE;
  BEGIN
    IF NEW.match_id IS NOT NULL THEN
      SELECT * INTO m FROM matches WHERE id = NEW.match_id;
      IF m.id IS NULL
         OR (m.user_a_id, m.user_b_id) IS DISTINCT FROM
            (least(NEW.blocker_id, NEW.blocked_id), greatest(NEW.blocker_id, NEW.blocked_id)) THEN
        RAISE EXCEPTION 'block rejected: not_participants' USING ERRCODE = 'SS060';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER blocks_10_guard_insert
  BEFORE INSERT ON blocks
  FOR EACH ROW EXECUTE FUNCTION blocks_guard_insert();
--> statement-breakpoint

-- A block ends the pair's chat at once (Q9, PLAN.md Phase 5): the same transaction closes every
-- open match between the two with reason `blocked` and cancels the pending notifications about
-- it. The match trigger of migration 0005 and the message trigger above refuse the pair from here
-- on, so a block is for good whatever the app does afterwards.
CREATE FUNCTION blocks_close_matches() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    WITH closed AS (
      UPDATE matches SET status = 'closed', close_reason = 'blocked', closed_at = now()
      WHERE user_a_id = least(NEW.blocker_id, NEW.blocked_id)
        AND user_b_id = greatest(NEW.blocker_id, NEW.blocked_id)
        AND status IN ('pending_game', 'results_ready', 'active')
      RETURNING id
    )
    UPDATE outbox SET status = 'cancelled', cancel_reason = 'blocked'
    WHERE status = 'pending' AND match_id IN (SELECT id FROM closed);
    RETURN NULL;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER blocks_90_close_matches
  AFTER INSERT ON blocks
  FOR EACH ROW EXECUTE FUNCTION blocks_close_matches();
--> statement-breakpoint

-- 4. `users.frozen_at` follows `status`: set when an account becomes frozen, cleared when it
-- stops being frozen, whoever writes the row. Runs between the band cache (20) and the closing of
-- matches (90).
CREATE FUNCTION users_track_frozen_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.status = 'frozen' THEN
      IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'frozen' OR NEW.frozen_at IS NULL THEN
        NEW.frozen_at := now();
      END IF;
    ELSE
      NEW.frozen_at := NULL;
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER users_25_track_frozen_at
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_track_frozen_at();
--> statement-breakpoint

-- 5. Account deletion (Q23, provisional): the profile is anonymized and the answers and interests
-- are removed, in one transaction, by the owner. The account row, its birth date (write-once,
-- Q16) and its Telegram ID stay, so the person can't start over with another birth date; reports
-- and audit rows stay as safety records. The status `deleted` makes the state-change trigger
-- close every open match and cancel the pending notifications. The app role has no DELETE on
-- answers, so this runs as the owner, and is the only thing the app can call for it.
CREATE FUNCTION user_delete_account(p_user_id uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_status user_status;
  BEGIN
    SELECT status INTO v_status FROM users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND OR v_status = 'deleted' THEN
      RETURN false;
    END IF;
    UPDATE users SET
      status = 'deleted',
      mode = NULL,
      gender = NULL,
      seeking = NULL,
      dating_age_min = NULL,
      dating_age_max = NULL,
      username = NULL,
      timezone = NULL,
      active_match_id = NULL
    WHERE id = p_user_id;
    DELETE FROM answers WHERE user_id = p_user_id;
    DELETE FROM user_interests WHERE user_id = p_user_id;
    RETURN true;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION user_delete_account(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_delete_account(uuid) TO samesync_app;
--> statement-breakpoint

-- 6. The admin command /setbirthdate (PLAN.md Phase 5) calls admin_set_birth_date() as the app
-- role: the grant Phase 1 left out on purpose. The function still requires an admin Telegram ID
-- and a reason, writes the audit row, and the band change it makes closes cross-band matches in
-- the same transaction (invariant 4). The allowlist check (ADMIN_TELEGRAM_IDS) is made by the bot
-- on every command and every button press. birth_date stays write-once for everything else.
GRANT EXECUTE ON FUNCTION admin_set_birth_date(uuid, date, bigint, text) TO samesync_app;
--> statement-breakpoint

-- Trigger functions are only ever run by their triggers.
REVOKE ALL ON FUNCTION reports_guard_insert(), reports_guard_update(), blocks_guard_insert(), blocks_close_matches(), users_track_frozen_at() FROM PUBLIC;
