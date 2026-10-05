import { describe, expect, it } from 'vitest';
import { CHAT_BANDS, DEFAULT_CHAT_PARAMS, chatOpenIn, revealAllowedIn } from './params';
import {
  chooseRoute,
  needsEcho,
  refusal,
  relayText,
  screen,
  textLength,
  textProblem,
  type ChatContext,
  type Route,
} from './relay';

const A = '0199-a';
const B = '0199-b';

function context(over: {
  status?: ChatContext['status'];
  band?: ChatContext['band'];
  locale?: ChatContext['locale'];
  blocked?: boolean;
  sender?: Partial<ChatContext['sender']>;
  recipient?: Partial<ChatContext['recipient']>;
}): ChatContext {
  const band = over.band ?? 'adult';
  return {
    matchId: 'm1',
    status: over.status ?? 'active',
    band,
    locale: over.locale ?? 'ru',
    blocked: over.blocked ?? false,
    sender: { id: A, status: 'active', liveBand: band, locale: 'ru', ...over.sender },
    recipient: {
      id: B,
      status: 'active',
      liveBand: band,
      locale: 'ru',
      telegramId: 7,
      botReachable: true,
      synthetic: false,
      ...over.recipient,
    },
    senderAlias: 'a.fox',
    recipientAlias: 'a.owl',
  };
}

const check = (over: Parameters<typeof context>[0], requireSameLocale = false) =>
  refusal(context(over), { requireSameLocale });

describe('the chat parameters', () => {
  it('keep the provisional numbers of PLAN.md', () => {
    expect(DEFAULT_CHAT_PARAMS).toEqual({
      maxLength: 2000,
      ratePerMinute: 20,
      reminderHoursBefore: 12,
      retentionDays: 30,
      requireSameLocale: false,
    });
  });

  it('open the chat for adults only: u18 waits for the contact filter', () => {
    expect(CHAT_BANDS).toEqual(['adult']);
    expect(chatOpenIn('adult')).toBe(true);
    expect(chatOpenIn('u18')).toBe(false);
  });

  it('never allow a reveal in the u18 band', () => {
    expect(revealAllowedIn('adult')).toBe(true);
    expect(revealAllowedIn('u18')).toBe(false);
  });
});

describe('refusal', () => {
  it('lets a message through while the chat is open, before and after the first message', () => {
    expect(check({ status: 'results_ready' })).toBeNull();
    expect(check({ status: 'active' })).toBeNull();
  });

  it('refuses before the game is finished and after the match is over', () => {
    expect(check({ status: 'pending_game' })).toBe('chat_not_open');
    expect(check({ status: 'expired' })).toBe('chat_ended');
    expect(check({ status: 'closed' })).toBe('chat_ended');
  });

  it.each(['frozen', 'deleted', 'waitlisted', 'onboarding', 'ineligible'] as const)(
    'refuses in both directions when one side is %s',
    (status) => {
      expect(check({ sender: { status } })).toBe('sender_not_active');
      expect(check({ recipient: { status } })).toBe('recipient_not_active');
    },
  );

  it('refuses when a live band differs from the band of the match, or is unknown', () => {
    expect(check({ sender: { liveBand: 'u18' } })).toBe('band_mismatch');
    expect(check({ recipient: { liveBand: 'u18' } })).toBe('band_mismatch');
    expect(check({ recipient: { liveBand: null } })).toBe('band_mismatch');
    expect(check({ band: 'u18', sender: { liveBand: 'adult' } })).toBe('band_mismatch');
    // Both moved to the same other band: still not the band of the match.
    expect(
      check({ band: 'u18', sender: { liveBand: 'adult' }, recipient: { liveBand: 'adult' } }),
    ).toBe('band_mismatch');
  });

  it('refuses every u18 chat, even between two u18 users who are both fine', () => {
    expect(check({ band: 'u18' })).toBe('u18_chat_closed');
    expect(check({ band: 'u18', status: 'results_ready' })).toBe('u18_chat_closed');
  });

  it('refuses a blocked pair', () => {
    expect(check({ blocked: true })).toBe('blocked');
  });

  it('ignores a language change unless the same language is required (Q36)', () => {
    const switched = { sender: { locale: 'en' as const } };
    expect(check(switched)).toBeNull();
    expect(check({ recipient: { locale: 'en' } })).toBeNull();
    expect(check(switched, true)).toBe('locale_mismatch');
    expect(check({ recipient: { locale: 'en' } }, true)).toBe('locale_mismatch');
    expect(check({}, true)).toBeNull();
    // Both switched: neither uses the language of the match any more.
    expect(check({ sender: { locale: 'en' }, recipient: { locale: 'en' } }, true)).toBe(
      'locale_mismatch',
    );
  });

  it('names the state of the match before anything about the users', () => {
    expect(check({ status: 'closed', sender: { status: 'frozen' }, blocked: true })).toBe(
      'chat_ended',
    );
    expect(check({ sender: { status: 'frozen', liveBand: 'u18' } })).toBe('sender_not_active');
    expect(check({ band: 'u18', recipient: { liveBand: 'adult' } })).toBe('band_mismatch');
  });
});

describe('textProblem', () => {
  const problem = (text: string | null) =>
    textProblem({ text, hasEntities: false }, DEFAULT_CHAT_PARAMS);

  it('accepts text up to the limit, counted in characters', () => {
    expect(problem('привет')).toBeNull();
    expect(problem('я'.repeat(2000))).toBeNull();
    expect(problem('я'.repeat(2001))).toBe('too_long');
    // An emoji is one character, as in the database's char_length().
    expect(textLength('🦊')).toBe(1);
    expect(problem('🦊'.repeat(2000))).toBeNull();
    expect(problem('🦊'.repeat(2001))).toBe('too_long');
  });

  it('refuses anything that is not text, and text without content', () => {
    expect(problem(null)).toBe('not_text');
    expect(problem('привет\u0000')).toBe('not_text');
    expect(problem('')).toBe('empty');
    expect(problem(' \n\t ')).toBe('empty');
  });
});

describe('screen', () => {
  const input = (band: 'adult' | 'u18', text: string | null, hasEntities = false) => ({
    band,
    content: { text, hasEntities },
    matchId: 'm1',
    senderId: A,
  });

  it('passes adult text, with or without entities (they are not passed on)', async () => {
    expect(await screen(input('adult', 'привет'))).toEqual({ pass: true });
    expect(await screen(input('adult', 'см. example.com', true))).toEqual({ pass: true });
  });

  it('rejects anything that is not text in both bands', async () => {
    const rejected = { pass: false, verdict: 'rejected', reason: 'not_text' };
    expect(await screen(input('adult', null))).toEqual(rejected);
    expect(await screen(input('u18', null))).toEqual(rejected);
  });

  it('passes nothing in the u18 band without a contact filter', async () => {
    expect(await screen(input('u18', 'привет'))).toEqual({
      pass: false,
      verdict: 'rejected',
      reason: 'no_contact_filter',
    });
  });

  it('rejects u18 text with entities before the filter is even asked', async () => {
    let asked = 0;
    const contactFilter = () => {
      asked++;
      return Promise.resolve({ hit: false });
    };
    expect(await screen(input('u18', 'привет', true), { contactFilter })).toEqual({
      pass: false,
      verdict: 'rejected',
      reason: 'entities',
    });
    expect(asked).toBe(0);
  });

  it('follows the contact filter once there is one: a hit blocks, an error rejects', async () => {
    const seen: unknown[] = [];
    const clean = (message: unknown) => {
      seen.push(message);
      return Promise.resolve({ hit: false });
    };
    expect(await screen(input('u18', 'привет'), { contactFilter: clean })).toEqual({ pass: true });
    expect(seen).toEqual([{ text: 'привет', matchId: 'm1', senderId: A }]);

    const hit = () => Promise.resolve({ hit: true, kind: 'handle' });
    expect(await screen(input('u18', 'мой ник…'), { contactFilter: hit })).toEqual({
      pass: false,
      verdict: 'blocked_by_filter',
      reason: 'handle',
    });
    const broken = () => Promise.reject(new Error('boom'));
    expect(await screen(input('u18', 'привет'), { contactFilter: broken })).toEqual({
      pass: false,
      verdict: 'rejected',
      reason: 'filter_error',
    });
  });

  it('never asks the filter about adult text', async () => {
    const contactFilter = () => Promise.reject(new Error('must not be called'));
    expect(await screen(input('adult', '@handle'), { contactFilter })).toEqual({ pass: true });
  });
});

describe('relayText', () => {
  it('is the alias, a line break and the text, and nothing else', () => {
    expect(relayText('🦊 Лиса', 'привет\nкак дела?')).toBe('🦊 Лиса\nпривет\nкак дела?');
  });
});

describe('chooseRoute', () => {
  const route = (over: Partial<Parameters<typeof chooseRoute>[0]>) =>
    chooseRoute({ replyMatchId: null, activeMatchId: null, openChats: [], ...over });

  it('sends a reply to the chat of the message it answers, whatever the active chat is', () => {
    expect(route({ replyMatchId: 'm2', activeMatchId: 'm1', openChats: ['m1', 'm2'] })).toEqual({
      kind: 'match',
      matchId: 'm2',
      via: 'reply',
    });
  });

  it('sends everything else to the active chat', () => {
    expect(route({ activeMatchId: 'm1', openChats: ['m1', 'm2'] })).toEqual({
      kind: 'match',
      matchId: 'm1',
      via: 'pointer',
    });
  });

  it('keeps the active chat as the target after it has ended, instead of moving the text', () => {
    // m1 is no longer open; m2 is. The relay will refuse m1 and tell the sender.
    expect(route({ activeMatchId: 'm1', openChats: ['m2'] })).toEqual({
      kind: 'match',
      matchId: 'm1',
      via: 'pointer',
    });
    expect(route({ activeMatchId: 'm1', openChats: [] })).toEqual({
      kind: 'match',
      matchId: 'm1',
      via: 'pointer',
    });
  });

  it('takes the only open chat when no chat is active', () => {
    expect(route({ openChats: ['m3'] })).toEqual({ kind: 'match', matchId: 'm3', via: 'only' });
  });

  it('asks when several chats are open and none is active', () => {
    expect(route({ openChats: ['m1', 'm2'] })).toEqual({ kind: 'pick' });
  });

  it('has nowhere to send without an open chat', () => {
    expect(route({})).toEqual({ kind: 'none' });
  });

  it('follows an explicit choice before everything else', () => {
    expect(
      route({ explicitMatchId: 'm9', replyMatchId: 'm2', activeMatchId: 'm1', openChats: ['m1'] }),
    ).toEqual({ kind: 'match', matchId: 'm9', via: 'explicit' });
  });
});

describe('needsEcho', () => {
  const to = (matchId: string, via: 'explicit' | 'reply' | 'pointer' | 'only'): Route => ({
    kind: 'match',
    matchId,
    via,
  });

  it('stays quiet while the conversation stays in one chat', () => {
    expect(needsEcho(to('m1', 'pointer'), 'm1')).toBe(false);
    expect(needsEcho(to('m1', 'reply'), 'm1')).toBe(false);
    expect(needsEcho(to('m1', 'only'), null)).toBe(false);
  });

  it('says where a message went when the latest message in the bot chat was of another chat', () => {
    expect(needsEcho(to('m1', 'pointer'), 'm2')).toBe(true);
    expect(needsEcho(to('m1', 'reply'), 'm2')).toBe(true);
    expect(needsEcho(to('m1', 'only'), 'm2')).toBe(true);
  });

  it('is not needed after an explicit choice, or when nothing was sent', () => {
    expect(needsEcho(to('m1', 'explicit'), 'm2')).toBe(false);
    expect(needsEcho({ kind: 'pick' }, 'm2')).toBe(false);
    expect(needsEcho({ kind: 'none' }, 'm2')).toBe(false);
  });
});
