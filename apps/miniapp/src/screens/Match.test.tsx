import type { MatchSummary, ResultsResponse } from '@samesync/shared/api';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client';
import { fakeApi, ok, renderWithI18n } from '../test-utils';
import { Match } from './Match';

afterEach(cleanup);

const ID = '01a10238-d68a-76a8-87cc-960f650dd8c3';
const MATCH: MatchSummary = {
  id: ID,
  alias: { emoji: '🦊', name: 'Лиса' },
  teaser: 'У кого-то здесь в плейлисте тоже Молчат Дома.',
  status: 'pending_game',
  createdAt: '2026-10-04T10:00:00.000Z',
  gameDeadlineAt: '2026-10-06T10:00:00.000Z',
  resultsReadyAt: null,
  chatDeadlineAt: null,
  game: { questions: 3, youDone: false, theyDone: false },
  chat: true,
};
const WAITING: MatchSummary = { ...MATCH, game: { questions: 3, youDone: true, theyDone: false } };
const READY: MatchSummary = {
  ...MATCH,
  status: 'results_ready',
  resultsReadyAt: '2026-10-04T12:00:00.000Z',
  chatDeadlineAt: '2026-10-06T12:00:00.000Z',
  game: { questions: 3, youDone: true, theyDone: true },
};
const QUESTIONS = [
  { id: 'q.a', text: 'Take A' },
  { id: 'q.b', text: 'Take B' },
  { id: 'q.c', text: 'Take C' },
];
const RESULTS: ResultsResponse = {
  total: 3,
  youGuessed: 2,
  theyGuessed: 1,
  rounds: [
    {
      questionId: 'q.a',
      text: 'Take A',
      yours: 'agree',
      theirs: 'agree',
      yourGuess: 'agree',
      theirGuess: 'disagree',
    },
    {
      questionId: 'q.b',
      text: 'Take B',
      yours: 'disagree',
      theirs: 'disagree',
      yourGuess: 'agree',
      theirGuess: 'disagree',
    },
    {
      questionId: 'q.c',
      text: 'Take C',
      yours: 'agree',
      theirs: 'disagree',
      yourGuess: 'disagree',
      theirGuess: 'disagree',
    },
  ],
  opener: 'Я за. А ты почему против?',
};
const ACTIVE: MatchSummary = { ...READY, status: 'active', chatDeadlineAt: null };
const failed = <T,>(
  code: 'conflict' | 'not_found' | 'out_of_order' | 'rate_limited' | 'unavailable' | 'forbidden',
): Promise<ApiResult<T>> => Promise.resolve({ kind: 'error', code, details: [] });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('<Match> playing the game', () => {
  it('goes from the intro through the cards and a last look to one submission, then waits', async () => {
    const api = fakeApi({
      game: vi.fn(() => ok({ questions: QUESTIONS })),
      submitPredictions: vi.fn(() => ok(WAITING)),
    });
    renderWithI18n(
      <Match api={api} match={MATCH} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: '🦊 Лиса' })).toBeTruthy();
    expect(
      screen.getByText(
        'Угадайте ответы друг друга: 3 карточки, а в конце — то, в чём вы разошлись.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Сыграть можно до .*октября/)).toBeTruthy();
    // Nothing is fetched before the player decides to play.
    expect(api.game).not.toHaveBeenCalled();

    click('Играть');
    expect(await screen.findByText('Take A')).toBeTruthy();
    expect(api.game).toHaveBeenCalledWith(ID);
    expect(screen.getByText('🦊 Лиса: за или против?')).toBeTruthy();
    expect(screen.getByText('1 из 3')).toBeTruthy();
    click('За');
    expect(screen.getByText('Take B')).toBeTruthy();
    click('Против');
    expect(screen.getByText('3 из 3')).toBeTruthy();
    // Back to the second card, to change the guess.
    click('Назад');
    expect(screen.getByText('Take B')).toBeTruthy();
    click('За');
    click('Против');

    // The last look: every take with the guess, and nothing sent yet.
    expect(screen.getByRole('heading', { name: 'Проверь прогноз' })).toBeTruthy();
    expect(screen.getByText('После отправки изменить его нельзя.')).toBeTruthy();
    expect(screen.getAllByText('🦊 Лиса: За')).toHaveLength(2);
    expect(screen.getAllByText('🦊 Лиса: Против')).toHaveLength(1);
    expect(api.submitPredictions).not.toHaveBeenCalled();

    click('Отправить');
    await waitFor(() =>
      expect(api.submitPredictions).toHaveBeenCalledWith(ID, [
        { questionId: 'q.a', value: 'agree' },
        { questionId: 'q.b', value: 'agree' },
        { questionId: 'q.c', value: 'disagree' },
      ]),
    );
    expect(api.submitPredictions).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(
        'Твой прогноз отправлен. Теперь очередь — 🦊 Лиса. Напишем в боте, когда будут результаты.',
      ),
    ).toBeTruthy();
  });

  it('lets the player step back: from the last look to the last card, from the first card to the intro', async () => {
    const api = fakeApi({ game: vi.fn(() => ok({ questions: QUESTIONS })) });
    renderWithI18n(
      <Match api={api} match={MATCH} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    click('Играть');
    await screen.findByText('Take A');
    click('Назад');
    expect(screen.getByRole('button', { name: 'Играть' })).toBeTruthy();
    click('Играть');
    await screen.findByText('Take A');
    click('За');
    click('За');
    click('За');
    expect(screen.getByRole('heading', { name: 'Проверь прогноз' })).toBeTruthy();
    click('Назад');
    expect(screen.getByText('Take C')).toBeTruthy();
    expect(api.submitPredictions).not.toHaveBeenCalled();
  });

  it('keeps the guesses when sending fails, so it can be tried again', async () => {
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'network' })
      .mockResolvedValueOnce({ kind: 'ok', data: WAITING });
    const api = fakeApi({
      game: vi.fn(() => ok({ questions: QUESTIONS })),
      submitPredictions: submit,
    });
    renderWithI18n(
      <Match api={api} match={MATCH} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    click('Играть');
    await screen.findByText('Take A');
    click('Против');
    click('Против');
    click('Против');
    click('Отправить');
    expect(await screen.findByText('Не получилось отправить. Попробуй ещё раз.')).toBeTruthy();
    click('Отправить');
    expect(await screen.findByText(/Твой прогноз отправлен/)).toBeTruthy();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
  });

  it('looks at the match again when the game can no longer be played', async () => {
    const api = fakeApi({
      game: vi.fn(() => failed<never>('conflict')),
      match: vi.fn(() => ok({ ...MATCH, status: 'expired' as const })),
    });
    renderWithI18n(
      <Match api={api} match={MATCH} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    click('Играть');
    expect(await screen.findByText('Это знакомство завершено.')).toBeTruthy();
    expect(api.match).toHaveBeenCalledWith(ID);
  });
});

describe('<Match> waiting for the other person', () => {
  it('shows the waiting screen and asks again when the app comes back to the foreground', async () => {
    const match = vi.fn().mockResolvedValueOnce({ kind: 'ok', data: WAITING });
    const api = fakeApi({ match, results: vi.fn(() => ok(RESULTS)) });
    renderWithI18n(
      <Match api={api} match={WAITING} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByText(/Теперь очередь — 🦊 Лиса/)).toBeTruthy();
    expect(match).not.toHaveBeenCalled();

    // The app becomes visible again: still waiting.
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(match).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Теперь очередь — 🦊 Лиса/)).toBeTruthy();

    // Later the window gets the focus back, and the other person has played.
    match.mockResolvedValueOnce({ kind: 'ok', data: READY });
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByRole('heading', { name: 'Результаты' })).toBeTruthy();
    expect(api.results).toHaveBeenCalledWith(ID);
  });

  it('can be refreshed by hand, and survives a network hiccup', async () => {
    const match = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'network' })
      .mockResolvedValueOnce({ kind: 'ok', data: READY });
    const api = fakeApi({ match, results: vi.fn(() => ok(RESULTS)) });
    renderWithI18n(
      <Match api={api} match={WAITING} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    click('Обновить');
    await waitFor(() => expect(match).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Теперь очередь — 🦊 Лиса/)).toBeTruthy();
    click('Обновить');
    expect(await screen.findByRole('heading', { name: 'Результаты' })).toBeTruthy();
  });

  it('does not poll while it is the player turn', () => {
    const api = fakeApi();
    renderWithI18n(
      <Match api={api} match={MATCH} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(api.match).not.toHaveBeenCalled();
  });
});

describe('<Match> results', () => {
  it('shows both scores, every question side by side, and the closing card last with its opener', async () => {
    const api = fakeApi({ results: vi.fn(() => ok(RESULTS)) });
    const onBack = vi.fn();
    renderWithI18n(
      <Match api={api} match={READY} matchId={ID} onOpenChat={vi.fn()} onBack={onBack} />,
    );
    expect(await screen.findByRole('heading', { name: 'Результаты' })).toBeTruthy();
    expect(screen.getByText('Твои верные прогнозы: 2 из 3')).toBeTruthy();
    expect(screen.getByText('🦊 Лиса — верных прогнозов: 1 из 3')).toBeTruthy();

    // The rounds in order, the closing question last, as its own card.
    const articles = screen.getAllByRole('article');
    expect(articles.map((a) => a.textContent?.slice(0, 6))).toEqual(['Take A', 'Take B', 'Take C']);
    expect(articles[0]?.textContent).toContain('Ты: За · 🦊 Лиса: За');
    expect(articles[0]?.textContent).toContain('Твой прогноз: верно · Прогноз о тебе: мимо');
    expect(articles[1]?.textContent).toContain('Ты: Против · 🦊 Лиса: Против');
    expect(articles[1]?.textContent).toContain('Твой прогноз: мимо · Прогноз о тебе: верно');
    const closing = screen.getByRole('heading', {
      name: 'Вы разошлись во мнении. Спроси, почему.',
    });
    // Everything before the closing heading is the earlier rounds; the closing card follows it.
    expect(closing.compareDocumentPosition(articles[1]!)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(closing.compareDocumentPosition(articles[2]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(articles[2]?.className).toBe('card');
    expect(screen.getByText('Ты: За · 🦊 Лиса: Против')).toBeTruthy();
    // The closing question counts like the others: both guesses are shown for it too (the same
    // outcome as in the first round).
    const marks = screen.getAllByText('Твой прогноз: верно · Прогноз о тебе: мимо');
    expect(marks).toHaveLength(2);
    expect(closing.compareDocumentPosition(marks[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // The opener is there to edit, and nothing is sent by looking at it.
    const opener = screen.getByLabelText('Первое сообщение');
    expect((opener as HTMLTextAreaElement).value).toBe('Я за. А ты почему против?');
    expect((opener as HTMLTextAreaElement).maxLength).toBe(2000);
    expect(api.results).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.submitPredictions).not.toHaveBeenCalled();

    click('Назад');
    expect(onBack).toHaveBeenCalled();
  });

  it('sends the edited opener as the first message, once, and then points to the bot chat', async () => {
    const sendMessage = vi.fn(() => ok(ACTIVE));
    const api = fakeApi({ results: vi.fn(() => ok(RESULTS)), sendMessage });
    const onOpenChat = vi.fn();
    renderWithI18n(
      <Match api={api} match={READY} matchId={ID} onOpenChat={onOpenChat} onBack={vi.fn()} />,
    );
    const opener = await screen.findByLabelText('Первое сообщение');
    fireEvent.change(opener, { target: { value: 'Привет! Почему против?' } });
    click('Написать');
    expect(await screen.findByText('Отправлено! Чат продолжается в боте.')).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(ID, 'Привет! Почему против?');
    // The composer is gone: the chat goes on in the bot, and there is nothing to send twice.
    expect(screen.queryByLabelText('Первое сообщение')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Написать' })).toBeNull();
    // The results stay where they were.
    expect(screen.getByText('Твои верные прогнозы: 2 из 3')).toBeTruthy();
    expect(api.results).toHaveBeenCalledTimes(1);

    click('Перейти в чат');
    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it('does not send an empty message, and not twice while one is on its way', async () => {
    let finish: (result: ApiResult<MatchSummary>) => void = () => undefined;
    const sendMessage = vi.fn(
      () => new Promise<ApiResult<MatchSummary>>((resolve) => (finish = resolve)),
    );
    const api = fakeApi({ results: vi.fn(() => ok(RESULTS)), sendMessage });
    renderWithI18n(
      <Match api={api} match={READY} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    const opener = await screen.findByLabelText('Первое сообщение');
    const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Написать' });
    fireEvent.change(opener, { target: { value: '   ' } });
    expect(send().disabled).toBe(true);
    fireEvent.click(send());
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.change(opener, { target: { value: 'Привет!' } });
    fireEvent.click(send());
    expect(send().disabled).toBe(true);
    fireEvent.click(send());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    finish({ kind: 'ok', data: ACTIVE });
    expect(await screen.findByText('Отправлено! Чат продолжается в боте.')).toBeTruthy();
  });

  it.each(['rate_limited', 'unavailable', 'forbidden'] as const)(
    'keeps the text when sending fails (%s), so it can be tried again',
    async (code) => {
      const sendMessage = vi
        .fn()
        .mockReturnValueOnce(failed<MatchSummary>(code))
        .mockReturnValueOnce(Promise.resolve({ kind: 'network' }))
        .mockReturnValueOnce(ok(ACTIVE));
      const api = fakeApi({ results: vi.fn(() => ok(RESULTS)), sendMessage });
      renderWithI18n(
        <Match api={api} match={READY} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
      );
      const opener = await screen.findByLabelText('Первое сообщение');
      fireEvent.change(opener, { target: { value: 'Привет!' } });
      click('Написать');
      expect(await screen.findByText('Не получилось отправить. Попробуй ещё раз.')).toBeTruthy();
      expect((opener as HTMLTextAreaElement).value).toBe('Привет!');
      click('Написать');
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
      expect(await screen.findByText('Не получилось отправить. Попробуй ещё раз.')).toBeTruthy();
      click('Написать');
      expect(await screen.findByText('Отправлено! Чат продолжается в боте.')).toBeTruthy();
    },
  );

  it('looks at the match again when the chat turns out to be over', async () => {
    const api = fakeApi({
      results: vi.fn(() => ok(RESULTS)),
      sendMessage: vi.fn(() => failed<MatchSummary>('conflict')),
      match: vi.fn(() => ok({ ...READY, status: 'closed' as const })),
    });
    renderWithI18n(
      <Match api={api} match={READY} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    await screen.findByLabelText('Первое сообщение');
    click('Написать');
    expect(await screen.findByText('Это знакомство завершено.')).toBeTruthy();
    expect(api.match).toHaveBeenCalledWith(ID);
  });

  it('shows no composer once the chat has started: it goes on in the bot', async () => {
    const api = fakeApi({ results: vi.fn(() => ok(RESULTS)) });
    const onOpenChat = vi.fn();
    renderWithI18n(
      <Match api={api} match={ACTIVE} matchId={ID} onOpenChat={onOpenChat} onBack={vi.fn()} />,
    );
    expect(await screen.findByText('Чат уже идёт в боте.')).toBeTruthy();
    expect(screen.queryByLabelText('Первое сообщение')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Написать' })).toBeNull();
    click('Перейти в чат');
    expect(onOpenChat).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('offers nothing to send in a match that has no chat', async () => {
    const api = fakeApi({ results: vi.fn(() => ok(RESULTS)) });
    renderWithI18n(
      <Match
        api={api}
        match={{ ...READY, chat: false }}
        matchId={ID}
        onOpenChat={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(await screen.findByText('Чат для этого знакомства пока недоступен.')).toBeTruthy();
    // The results themselves are all there.
    expect(screen.getByText('Твои верные прогнозы: 2 из 3')).toBeTruthy();
    expect(screen.queryByLabelText('Первое сообщение')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Написать' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Перейти в чат' })).toBeNull();
  });

  it('opens the results straight from a bot notification, loading the match by ID', async () => {
    const api = fakeApi({ match: vi.fn(() => ok(READY)), results: vi.fn(() => ok(RESULTS)) });
    renderWithI18n(<Match api={api} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Результаты' })).toBeTruthy();
    expect(api.match).toHaveBeenCalledWith(ID);
  });

  it('falls back to the match when the results are not there after all', async () => {
    const api = fakeApi({
      results: vi.fn(() => failed<ResultsResponse>('out_of_order')),
      match: vi.fn(() => ok(WAITING)),
    });
    renderWithI18n(
      <Match api={api} match={READY} matchId={ID} onOpenChat={vi.fn()} onBack={vi.fn()} />,
    );
    expect(await screen.findByText(/Теперь очередь — 🦊 Лиса/)).toBeTruthy();
  });
});

describe('<Match> that is over or gone', () => {
  it('says that a match has ended, and that one is not available', async () => {
    const ended = renderWithI18n(
      <Match
        api={fakeApi()}
        match={{ ...MATCH, status: 'expired' }}
        matchId={ID}
        onOpenChat={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText('Это знакомство завершено.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Играть' })).toBeNull();
    ended.unmount();

    const api = fakeApi({ match: vi.fn(() => failed<MatchSummary>('not_found')) });
    renderWithI18n(<Match api={api} matchId="gone" onOpenChat={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText('Это знакомство недоступно.')).toBeTruthy();
  });

  it('treats an open match without a game as ended', () => {
    renderWithI18n(
      <Match
        api={fakeApi()}
        match={{ ...MATCH, game: null }}
        matchId={ID}
        onOpenChat={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText('Это знакомство завершено.')).toBeTruthy();
  });
});
