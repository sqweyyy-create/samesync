-- Chat safety (CLAUDE.md invariants 1, 2, 4, 5, 6 and 9; PLAN.md §3 layer 2).
-- A message goes from one user to the other, and a reveal shows each user the other's username.
-- So the database decides who may store a message, when a chat has started and when usernames may
-- be revealed, as it does for a match and a prediction: both users' bands are re-derived from
-- birth_date at write time. users.age_band is a cache and is never the basis of a decision here.
-- The functions pin search_path with pg_temp last, so a temporary table can't shadow users,
-- matches, blocks, messages or reveal_consents.

-- A message can only be stored by a participant of a match whose chat is open (`results_ready` or
-- `active`), while both users are active, by birth date in the match's band, and not blocked.
-- Nothing is stored in a u18 match: every u18 message has to pass the contact filter first
-- (invariant 5), and that filter does not exist before Phase 5. Until a later migration lifts
-- this, the database refuses, whatever the app or U18_POOL_ENABLED says.
-- The message names the failed rule.
CREATE FUNCTION messages_guard_insert() RETURNS trigger
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
    IF m.band IS DISTINCT FROM 'adult' THEN
      RAISE EXCEPTION 'message rejected: u18_chat_closed' USING ERRCODE = 'SS030';
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
CREATE TRIGGER messages_10_guard_insert
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_guard_insert();
--> statement-breakpoint

-- A stored message is a record: who wrote it, in which match and when never changes. Its text can
-- only be removed (the retention purge). The delivery and the two Telegram message IDs are written
-- once. A message that was accepted can only be marked as not delivered, and only before it has
-- reached anyone.
CREATE FUNCTION messages_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF (NEW.id, NEW.match_id, NEW.sender_id, NEW.created_at, NEW.purge_after)
       IS DISTINCT FROM
       (OLD.id, OLD.match_id, OLD.sender_id, OLD.created_at, OLD.purge_after)
    THEN
      RAISE EXCEPTION 'messages: the sender, the match and the time of a message are immutable'
        USING ERRCODE = 'SS031';
    END IF;
    IF NEW.body IS DISTINCT FROM OLD.body AND NEW.body IS NOT NULL THEN
      RAISE EXCEPTION 'messages: the text of a message can only be removed' USING ERRCODE = 'SS031';
    END IF;
    IF (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
       OR (OLD.sender_tg_message_id IS NOT NULL
        AND NEW.sender_tg_message_id IS DISTINCT FROM OLD.sender_tg_message_id)
       OR (OLD.recipient_tg_message_id IS NOT NULL
        AND NEW.recipient_tg_message_id IS DISTINCT FROM OLD.recipient_tg_message_id) THEN
      RAISE EXCEPTION 'messages: a delivery and its Telegram message IDs are written once'
        USING ERRCODE = 'SS031';
    END IF;
    IF NEW.verdict IS DISTINCT FROM OLD.verdict
       AND NOT (OLD.verdict = 'delivered' AND NEW.verdict = 'rejected' AND OLD.delivered_at IS NULL)
    THEN
      RAISE EXCEPTION 'messages: only a message that has not reached anyone can be marked rejected'
        USING ERRCODE = 'SS031';
    END IF;
    IF NEW.reason IS DISTINCT FROM OLD.reason AND NEW.verdict IS NOT DISTINCT FROM OLD.verdict THEN
      RAISE EXCEPTION 'messages: the reason belongs to the verdict' USING ERRCODE = 'SS031';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER messages_10_guard_update
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_guard_update();
--> statement-breakpoint

-- Usernames are revealed only in the adult band (invariant 6). Consent can only be given by a
-- participant of an adult match whose chat is open, while both users are active, adults by birth
-- date right now, and not blocked. So a u18 user can never have a consent row, whatever the app
-- does. A consent starts unrevealed.
CREATE FUNCTION reveal_consents_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    m matches%ROWTYPE;
    a users%ROWTYPE;
    b users%ROWTYPE;
    v_today date := vc_today();
  BEGIN
    SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR SHARE;
    IF m.id IS NULL THEN
      RAISE EXCEPTION 'reveal rejected: unknown_match' USING ERRCODE = 'SS040';
    END IF;
    IF NEW.user_id IS DISTINCT FROM m.user_a_id AND NEW.user_id IS DISTINCT FROM m.user_b_id THEN
      RAISE EXCEPTION 'reveal rejected: not_participant' USING ERRCODE = 'SS040';
    END IF;
    IF m.status NOT IN ('results_ready', 'active') THEN
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
    IF NEW.revealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'reveal rejected: not_mutual' USING ERRCODE = 'SS040';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER reveal_consents_10_guard_insert
  BEFORE INSERT ON reveal_consents
  FOR EACH ROW EXECUTE FUNCTION reveal_consents_guard_insert();
--> statement-breakpoint

-- Who consented and when never changes. `revealed_at` is set once, and only when both users of
-- the match have consented, while the chat is still open and both are still active adults by
-- birth date: the same rules as for giving consent, checked again at the moment of the reveal.
CREATE FUNCTION reveal_consents_guard_update() RETURNS trigger
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
    -- two consents.
    IF (SELECT count(*) FROM reveal_consents WHERE match_id = NEW.match_id) <> 2 THEN
      RAISE EXCEPTION 'reveal rejected: not_mutual' USING ERRCODE = 'SS040';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER reveal_consents_10_guard_update
  BEFORE UPDATE ON reveal_consents
  FOR EACH ROW EXECUTE FUNCTION reveal_consents_guard_update();
--> statement-breakpoint

-- A match becomes `active` when its chat starts: only from `results_ready`, only with a message
-- that has been delivered, and only while both users are active and, by birth date, in the
-- match's band. A chat that has started never expires (Q2): `expired` is for a game nobody
-- finished and for a chat nobody wrote in.
-- The users are read without a lock, like in matches_guard_game_status().
CREATE FUNCTION matches_guard_chat_status() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    a users%ROWTYPE;
    b users%ROWTYPE;
    v_today date := vc_today();
    v_started boolean;
  BEGIN
    v_started := EXISTS (
      SELECT 1 FROM messages WHERE match_id = NEW.id AND delivered_at IS NOT NULL
    );
    IF NEW.status = 'expired' THEN
      IF OLD.status = 'active' OR v_started THEN
        RAISE EXCEPTION 'match status rejected: chat_started' USING ERRCODE = 'SS012';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status <> 'results_ready' THEN
      RAISE EXCEPTION 'match status rejected: not_results_ready' USING ERRCODE = 'SS012';
    END IF;
    IF NOT v_started THEN
      RAISE EXCEPTION 'match status rejected: no_message' USING ERRCODE = 'SS012';
    END IF;
    SELECT * INTO a FROM users WHERE id = NEW.user_a_id;
    SELECT * INTO b FROM users WHERE id = NEW.user_b_id;
    IF a.status IS DISTINCT FROM 'active' OR b.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'match status rejected: not_active' USING ERRCODE = 'SS012';
    END IF;
    IF vc_band(a.birth_date, v_today) IS DISTINCT FROM NEW.band
       OR vc_band(b.birth_date, v_today) IS DISTINCT FROM NEW.band THEN
      RAISE EXCEPTION 'match status rejected: band' USING ERRCODE = 'SS012';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
-- Runs after matches_10_guard_update (a closed match stays closed).
CREATE TRIGGER matches_30_guard_chat_status
  BEFORE UPDATE ON matches
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('active', 'expired'))
  EXECUTE FUNCTION matches_guard_chat_status();
--> statement-breakpoint

-- Trigger functions are only ever run by their triggers.
REVOKE ALL ON FUNCTION messages_guard_insert(), messages_guard_update(), reveal_consents_guard_insert(), reveal_consents_guard_update(), matches_guard_chat_status() FROM PUBLIC;
--> statement-breakpoint

-- Least privilege. A message is stored once: afterwards the app can only record its delivery (or
-- that it failed) and remove its text when the retention period is over. Consent is given once:
-- the app can only mark it revealed. Neither table can be deleted from.
GRANT SELECT, INSERT ON messages, reveal_consents TO samesync_app;
--> statement-breakpoint
GRANT UPDATE (body, verdict, reason, sender_tg_message_id, recipient_tg_message_id, delivered_at) ON messages TO samesync_app;
--> statement-breakpoint
GRANT UPDATE (revealed_at) ON reveal_consents TO samesync_app;
