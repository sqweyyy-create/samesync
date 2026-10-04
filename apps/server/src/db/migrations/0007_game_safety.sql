-- Game safety (CLAUDE.md invariants 1, 2, 4 and 9; PLAN.md §3 layer 2).
-- A prediction is game data that goes from one user to the other, and the results show each user
-- the other's answers. So the database decides who may write a prediction and when results become
-- ready, as it does for a match: both users' bands are re-derived from birth_date at write time.
-- users.age_band is a cache and is never the basis of a decision here.
-- The functions pin search_path with pg_temp last, so a temporary table can't shadow users,
-- matches, games or game_predictions.

-- A prediction can only be written by a participant of a match whose game is still being played,
-- while both users are active and, by birth date, in the match's band. It must be about a question
-- of that game, and a player who has finished can't add another. The message names the failed rule.
CREATE FUNCTION game_predictions_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    m matches%ROWTYPE;
    a users%ROWTYPE;
    b users%ROWTYPE;
    g games%ROWTYPE;
    v_today date := vc_today();
  BEGIN
    SELECT * INTO m FROM matches WHERE id = NEW.match_id;
    IF m.id IS NULL THEN
      RAISE EXCEPTION 'prediction rejected: unknown_match' USING ERRCODE = 'SS020';
    END IF;
    IF NEW.predictor_id IS DISTINCT FROM m.user_a_id AND NEW.predictor_id IS DISTINCT FROM m.user_b_id THEN
      RAISE EXCEPTION 'prediction rejected: not_participant' USING ERRCODE = 'SS020';
    END IF;
    -- Share-lock both users in the order the match trigger uses, then read the match again under
    -- a lock: a concurrent freeze, birth-date correction or expiry has either finished, and is
    -- visible here, or waits for this transaction and then closes the match.
    SELECT * INTO a FROM users WHERE id = m.user_a_id FOR SHARE;
    SELECT * INTO b FROM users WHERE id = m.user_b_id FOR SHARE;
    SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR SHARE;
    IF m.status <> 'pending_game' THEN
      RAISE EXCEPTION 'prediction rejected: game_over' USING ERRCODE = 'SS020';
    END IF;
    -- Frozen, deleted and every other non-active status: fail closed.
    IF a.status <> 'active' OR b.status <> 'active' THEN
      RAISE EXCEPTION 'prediction rejected: not_active' USING ERRCODE = 'SS020';
    END IF;
    IF vc_band(a.birth_date, v_today) IS DISTINCT FROM m.band
       OR vc_band(b.birth_date, v_today) IS DISTINCT FROM m.band THEN
      RAISE EXCEPTION 'prediction rejected: band' USING ERRCODE = 'SS020';
    END IF;
    SELECT * INTO g FROM games WHERE match_id = NEW.match_id;
    IF g.match_id IS NULL OR NOT (NEW.question_id = ANY (g.question_ids)) THEN
      RAISE EXCEPTION 'prediction rejected: not_in_game' USING ERRCODE = 'SS020';
    END IF;
    IF (NEW.predictor_id = m.user_a_id AND g.a_done_at IS NOT NULL)
       OR (NEW.predictor_id = m.user_b_id AND g.b_done_at IS NOT NULL) THEN
      RAISE EXCEPTION 'prediction rejected: already_finished' USING ERRCODE = 'SS020';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER game_predictions_10_guard_insert
  BEFORE INSERT ON game_predictions
  FOR EACH ROW EXECUTE FUNCTION game_predictions_guard_insert();
--> statement-breakpoint

-- The questions and the answer snapshot of a game never change, a player who has finished stays
-- finished, and a player is finished only with a prediction for every question of the game.
CREATE FUNCTION games_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_user_a uuid;
    v_user_b uuid;
  BEGIN
    IF (NEW.match_id, NEW.question_ids, NEW.closing_question_id, NEW.answers_a, NEW.answers_b, NEW.created_at)
       IS DISTINCT FROM
       (OLD.match_id, OLD.question_ids, OLD.closing_question_id, OLD.answers_a, OLD.answers_b, OLD.created_at)
    THEN
      RAISE EXCEPTION 'games: the questions and answers of a game are immutable'
        USING ERRCODE = 'SS021';
    END IF;
    IF (OLD.a_done_at IS NOT NULL AND NEW.a_done_at IS DISTINCT FROM OLD.a_done_at)
       OR (OLD.b_done_at IS NOT NULL AND NEW.b_done_at IS DISTINCT FROM OLD.b_done_at) THEN
      RAISE EXCEPTION 'games: a player who has finished stays finished' USING ERRCODE = 'SS021';
    END IF;
    SELECT user_a_id, user_b_id INTO v_user_a, v_user_b FROM matches WHERE id = NEW.match_id;
    IF OLD.a_done_at IS NULL AND NEW.a_done_at IS NOT NULL AND (
      SELECT count(*) FROM game_predictions WHERE match_id = NEW.match_id AND predictor_id = v_user_a
    ) <> cardinality(NEW.question_ids) THEN
      RAISE EXCEPTION 'games: predictions are incomplete' USING ERRCODE = 'SS021';
    END IF;
    IF OLD.b_done_at IS NULL AND NEW.b_done_at IS NOT NULL AND (
      SELECT count(*) FROM game_predictions WHERE match_id = NEW.match_id AND predictor_id = v_user_b
    ) <> cardinality(NEW.question_ids) THEN
      RAISE EXCEPTION 'games: predictions are incomplete' USING ERRCODE = 'SS021';
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER games_10_guard_update
  BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION games_guard_update();
--> statement-breakpoint

-- A match moves from `pending_game` to `results_ready` only when both players have finished, and
-- only while both users are active and, by birth date, in the match's band: from then on each of
-- them can see the other's answers. A game never starts over.
-- The users are read without a lock: a freeze or birth-date correction that commits after this
-- check closes the match itself (the state-change trigger), whatever its status is by then.
CREATE FUNCTION matches_guard_game_status() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    a users%ROWTYPE;
    b users%ROWTYPE;
    g games%ROWTYPE;
    v_today date := vc_today();
  BEGIN
    IF NEW.status = 'pending_game' THEN
      RAISE EXCEPTION 'match status rejected: game_cannot_restart' USING ERRCODE = 'SS012';
    END IF;
    IF OLD.status <> 'pending_game' THEN
      RAISE EXCEPTION 'match status rejected: not_pending_game' USING ERRCODE = 'SS012';
    END IF;
    SELECT * INTO g FROM games WHERE match_id = NEW.id;
    IF g.match_id IS NULL OR g.a_done_at IS NULL OR g.b_done_at IS NULL THEN
      RAISE EXCEPTION 'match status rejected: game_not_finished' USING ERRCODE = 'SS012';
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
CREATE TRIGGER matches_20_guard_game_status
  BEFORE UPDATE ON matches
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('pending_game', 'results_ready'))
  EXECUTE FUNCTION matches_guard_game_status();
--> statement-breakpoint

-- Trigger functions are only ever run by their triggers.
REVOKE ALL ON FUNCTION game_predictions_guard_insert(), games_guard_update(), matches_guard_game_status() FROM PUBLIC;
--> statement-breakpoint

-- Least privilege. The app creates a game with its match (SELECT and INSERT since migration 0005)
-- and marks each player finished; nothing else of a game can be changed. Predictions are
-- write-once: no UPDATE and no DELETE.
GRANT UPDATE (a_done_at, b_done_at) ON games TO samesync_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON game_predictions TO samesync_app;
