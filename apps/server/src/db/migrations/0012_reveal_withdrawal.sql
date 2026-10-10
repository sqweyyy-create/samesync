-- Withdrawing a consent to reveal usernames (Q38, decided 2026-10-10; CLAUDE.md invariant 6).
-- A consent can be taken back at any time until the reveal has happened: the row is deleted, and
-- the user can consent again later. Once `revealed_at` is set, the record that both consented and
-- each was shown the other's username stays for good, so neither row can be deleted any more.
-- Like the functions of migration 0010, these pin search_path with pg_temp last.

-- A consent can be withdrawn only while the reveal of its match has not happened. The reveal marks
-- both rows at once (the update trigger below), so the other row of the match is checked too: the
-- rule is about the match, not about one row.
CREATE FUNCTION reveal_consents_guard_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF OLD.revealed_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM reveal_consents WHERE match_id = OLD.match_id AND revealed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'reveal_consents: a consent cannot be withdrawn after the reveal'
        USING ERRCODE = 'SS042';
    END IF;
    RETURN OLD;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER reveal_consents_10_guard_delete
  BEFORE DELETE ON reveal_consents
  FOR EACH ROW EXECUTE FUNCTION reveal_consents_guard_delete();
--> statement-breakpoint

-- The same function as in migration 0010, with one change: the reveal now locks both consents
-- (FOR UPDATE) before it counts them. A withdrawal that is in flight at that moment is waited
-- for, so the two can never cross: either the withdrawal commits first and the reveal finds one
-- consent and is refused, or the reveal commits first and the withdrawal finds a revealed consent
-- and is refused. Without the lock, a withdrawal could slip in between the count and the commit,
-- and one row of the match would be revealed on its own.
CREATE OR REPLACE FUNCTION reveal_consents_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    m matches%ROWTYPE;
    a users%ROWTYPE;
    b users%ROWTYPE;
    v_today date := vc_today();
  BEGIN
    IF (NEW.match_id, NEW.user_id, NEW.consented_at)
       IS DISTINCT FROM (OLD.match_id, OLD.user_id, OLD.consented_at) THEN
      RAISE EXCEPTION 'reveal_consents: who consented and when is immutable' USING ERRCODE = 'SS041';
    END IF;
    IF NEW.revealed_at IS NOT DISTINCT FROM OLD.revealed_at THEN
      RETURN NEW;
    END IF;
    IF OLD.revealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'reveal_consents: a reveal is recorded once' USING ERRCODE = 'SS041';
    END IF;

    SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR SHARE;
    IF m.id IS NULL OR m.status NOT IN ('results_ready', 'active') THEN
      RAISE EXCEPTION 'reveal rejected: chat_not_open' USING ERRCODE = 'SS040';
    END IF;
    IF m.band IS DISTINCT FROM 'adult' THEN
      RAISE EXCEPTION 'reveal rejected: not_adult' USING ERRCODE = 'SS040';
    END IF;
    SELECT * INTO a FROM users WHERE id = m.user_a_id;
    SELECT * INTO b FROM users WHERE id = m.user_b_id;
    IF a.status IS DISTINCT FROM 'active' OR b.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'reveal rejected: not_active' USING ERRCODE = 'SS040';
    END IF;
    IF vc_band(a.birth_date, v_today) IS DISTINCT FROM 'adult'
       OR vc_band(b.birth_date, v_today) IS DISTINCT FROM 'adult' THEN
      RAISE EXCEPTION 'reveal rejected: band' USING ERRCODE = 'SS040';
    END IF;
    IF EXISTS (
      SELECT 1 FROM blocks
      WHERE (blocker_id = a.id AND blocked_id = b.id) OR (blocker_id = b.id AND blocked_id = a.id)
    ) THEN
      RAISE EXCEPTION 'reveal rejected: blocked' USING ERRCODE = 'SS040';
    END IF;
    -- Both participants, and nobody else, can have a row (the insert trigger), so two rows are
    -- two consents. The rows are locked: a withdrawal that is under way is waited for and counted
    -- as what it is (see above), and a withdrawal that comes later waits for this reveal.
    IF (SELECT count(*) FROM (
          SELECT 1 FROM reveal_consents WHERE match_id = NEW.match_id FOR UPDATE
        ) AS consents) <> 2 THEN
      RAISE EXCEPTION 'reveal rejected: not_mutual' USING ERRCODE = 'SS040';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint

-- Trigger functions are only ever run by their triggers.
REVOKE ALL ON FUNCTION reveal_consents_guard_delete() FROM PUBLIC;
--> statement-breakpoint

-- The app can now remove a consent; the trigger limits that to a consent that was not revealed.
GRANT DELETE ON reveal_consents TO samesync_app;
