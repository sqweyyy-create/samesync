/**
 * The chat of a real development user with a synthetic counterpart: the synthetic side can say
 * something, and can consent to a username reveal, through the same relay and reveal services the
 * bot uses. So the real user gets everything in Telegram exactly as from a real person.
 * Only ever acts for the synthetic user of a chat that has exactly one, never for a real one.
 */
import type { Locale, MatchStatus } from '@samesync/shared';
import type pg from 'pg';
import { aliasText, localized, type ContentStore } from '../../src/content/store';
import type { RelayResult, RelayService } from '../../src/services/relay';
import type { ConsentOutcome, RevealService } from '../../src/services/reveal';

/** An open chat between one real user and one synthetic user. */
export interface DevChat {
  matchId: string;
  status: MatchStatus;
  real: { id: string; publicId: string; locale: Locale };
  /** The synthetic counterpart, and the content alias the real user sees it under. */
  synthetic: { id: string; alias: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  status: MatchStatus;
  a_synthetic: boolean;
  user_a_id: string;
  user_b_id: string;
  a_public_id: string;
  b_public_id: string;
  a_locale: Locale;
  b_locale: Locale;
  alias_a: string;
  alias_b: string;
}

/** Every open chat that has exactly one synthetic side, newest first. */
export async function devChats(db: pg.Pool): Promise<DevChat[]> {
  const { rows } = await db.query<Row>(
    `SELECT m.id, m.status::text AS status, ua.synthetic AS a_synthetic,
       m.user_a_id, m.user_b_id, ua.public_id AS a_public_id, ub.public_id AS b_public_id,
       ua.locale::text AS a_locale, ub.locale::text AS b_locale, m.alias_a, m.alias_b
     FROM matches m
     JOIN users ua ON ua.id = m.user_a_id
     JOIN users ub ON ub.id = m.user_b_id
     WHERE m.status IN ('results_ready', 'active') AND ua.synthetic <> ub.synthetic
     ORDER BY m.created_at DESC, m.id DESC`,
  );
  return rows.map((r) =>
    r.a_synthetic
      ? {
          matchId: r.id,
          status: r.status,
          real: { id: r.user_b_id, publicId: r.b_public_id, locale: r.b_locale },
          // `alias_a` is how user A appears to user B.
          synthetic: { id: r.user_a_id, alias: r.alias_a },
        }
      : {
          matchId: r.id,
          status: r.status,
          real: { id: r.user_a_id, publicId: r.a_public_id, locale: r.a_locale },
          synthetic: { id: r.user_b_id, alias: r.alias_b },
        },
  );
}

/**
 * The chats `selector` names: a match ID, or the alias of the synthetic counterpart as the real
 * user sees it ("a.fox", "fox", "Лиса", "🦊"), in any letter case.
 */
export function selectDevChats(
  chats: readonly DevChat[],
  content: Pick<ContentStore, 'alias'>,
  selector: string,
): DevChat[] {
  const wanted = selector.trim().toLowerCase();
  if (UUID.test(wanted)) return chats.filter((c) => c.matchId === wanted);
  return chats.filter((c) => {
    const alias = content.alias(c.synthetic.alias);
    const names = [
      c.synthetic.alias,
      c.synthetic.alias.replace(/^a\./, ''),
      ...(alias
        ? [alias.emoji, localized(alias.text, 'ru'), localized(alias.text, 'en')].flatMap(
            (name) => [name, `${alias.emoji} ${name}`],
          )
        : []),
    ];
    return names.some((name) => name.toLowerCase() === wanted);
  });
}

/** One line per chat, for a list to choose from. */
export function describeDevChat(chat: DevChat, content: Pick<ContentStore, 'alias'>): string {
  const alias = aliasText(content, chat.synthetic.alias, chat.real.locale);
  return `${chat.matchId}  ${alias}  (${chat.status}, user ${chat.real.publicId})`;
}

/** The synthetic counterpart writes `text`: it goes through the real relay to the real user. */
export function sayAsCounterpart(
  deps: { relay: Pick<RelayService, 'send'> },
  chat: DevChat,
  text: string,
): Promise<RelayResult> {
  return deps.relay.send({
    senderId: chat.synthetic.id,
    content: { text, hasEntities: false },
    tgMessageId: null,
    matchId: chat.matchId,
  });
}

/** The synthetic counterpart consents to exchange usernames, through the real reveal service. */
export function consentAsCounterpart(
  deps: { reveal: Pick<RevealService, 'consent'> },
  chat: DevChat,
): Promise<ConsentOutcome> {
  return deps.reveal.consent(chat.synthetic.id, chat.matchId);
}

export interface TranscriptLine {
  from: 'user' | 'counterpart';
  /** Null once the retention purge has removed the text. */
  text: string | null;
  /** Delivered, on its way, or the reason it was not delivered. */
  state: string;
}

/** The latest messages of a development chat, oldest first: what each side sent the other. */
export async function transcript(
  db: pg.Pool,
  chat: DevChat,
  limit = 20,
): Promise<TranscriptLine[]> {
  const { rows } = await db.query<{
    sender_id: string;
    body: string | null;
    verdict: string;
    reason: string | null;
    delivered: boolean;
  }>(
    `SELECT sender_id, body, verdict::text AS verdict, reason, delivered_at IS NOT NULL AS delivered
     FROM (
       SELECT * FROM messages WHERE match_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
     ) latest
     ORDER BY created_at, id`,
    [chat.matchId, limit],
  );
  return rows.map((r) => ({
    from: r.sender_id === chat.synthetic.id ? 'counterpart' : 'user',
    text: r.body,
    state: r.delivered
      ? 'delivered'
      : r.verdict === 'delivered'
        ? 'on its way'
        : (r.reason ?? r.verdict),
  }));
}
