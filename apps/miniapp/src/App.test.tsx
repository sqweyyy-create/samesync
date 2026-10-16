import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fakeApi, fakePlatform, me, ok, renderWithI18n } from './test-utils';

afterEach(cleanup);
const TODAY = '2026-10-03';

describe('<App> routing by onboarding step', () => {
  it('sends a u18 user from the birth date straight to the deck, never to the mode picker', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(me({ step: 'birth_date' }))),
      setBirthDate: vi.fn(() =>
        ok(me({ step: 'answers', band: 'u18', mode: 'friends', birthDate: '2010-05-20', age: 16 })),
      ),
      deck: vi.fn(() => ok({ questions: [{ id: 'q.a', text: 'Take A' }], answers: [] })),
    });
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} />);
    fireEvent.change(await screen.findByLabelText('Дата рождения'), {
      target: { value: '2010-05-20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Дальше' }));
    fireEvent.click(screen.getByRole('button', { name: 'Да, верно' }));
    expect(await screen.findByText('Take A')).toBeTruthy();
    expect(screen.queryByText('Кого ищешь?')).toBeNull();
    expect(api.setMode).not.toHaveBeenCalled();
  });

  it('shows the mode picker to adults, with dating details from the API', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(me({ step: 'mode', band: 'adult', birthDate: '2000-01-01', age: 26 }))),
      setMode: vi.fn(() =>
        ok(
          me({
            step: 'answers',
            band: 'adult',
            mode: 'dating',
            gender: 'g.woman',
            seeking: ['g.man'],
          }),
        ),
      ),
      deck: vi.fn(() => ok({ questions: [{ id: 'q.a', text: 'Take A' }], answers: [] })),
    });
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} />);
    expect(await screen.findByText('Кого ищешь?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Отношения/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Женщина' }));
    fireEvent.click(screen.getByRole('button', { name: 'Мужчин' }));
    fireEvent.click(screen.getByRole('button', { name: 'Дальше' }));
    await waitFor(() =>
      expect(api.setMode).toHaveBeenCalledWith({
        mode: 'dating',
        gender: 'g.woman',
        seeking: ['g.man'],
      }),
    );
  });

  it('shows the ineligible screen for under-14 users', async () => {
    renderWithI18n(
      <App
        api={fakeApi({ getMe: vi.fn(() => ok(me({ step: 'ineligible', status: 'ineligible' }))) })}
        platform={fakePlatform()}
        today={TODAY}
      />,
    );
    expect(
      await screen.findByText(
        'SameSync — для тех, кому уже есть 14. Возвращайся, когда исполнится 14!',
      ),
    ).toBeTruthy();
  });

  it('switches the UI to the stored locale even if Telegram reports another language (Q13)', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(me({ step: 'ineligible', status: 'ineligible', locale: 'en' }))),
    });
    renderWithI18n(
      <App api={api} platform={fakePlatform({ languageCode: () => 'ru' })} today={TODAY} />,
      'ru',
    );
    expect(
      await screen.findByText("SameSync is for people aged 14 and over. Come back once you're 14!"),
    ).toBeTruthy();
  });

  it('asks outside Telegram to open the app in Telegram, without calling the API', () => {
    const api = fakeApi();
    renderWithI18n(<App api={api} platform={fakePlatform({ inTelegram: false })} today={TODAY} />);
    expect(screen.getByText('Открой SameSync в Telegram.')).toBeTruthy();
    expect(api.getMe).not.toHaveBeenCalled();
  });
});

describe('<App> settings: dating age range (Q12)', () => {
  const dating = me({
    step: 'done',
    status: 'active',
    band: 'adult',
    birthDate: '2000-01-01',
    age: 26,
    mode: 'dating',
    gender: 'g.woman',
    seeking: ['g.man'],
    datingAgeMin: 21,
    datingAgeMax: 31,
  });

  async function openModeSettings(api: ReturnType<typeof fakeApi>) {
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Настройки' }));
    fireEvent.click(screen.getByRole('button', { name: 'Режим' }));
    return { from: await screen.findByLabelText('от'), to: screen.getByLabelText('до') };
  }

  it('shows the stored range and saves a changed one', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(dating)),
      setMode: vi.fn(() => ok({ ...dating, datingAgeMin: 24, datingAgeMax: 35 })),
    });
    const { from, to } = await openModeSettings(api);
    expect([(from as HTMLInputElement).value, (to as HTMLInputElement).value]).toEqual([
      '21',
      '31',
    ]);
    fireEvent.change(from, { target: { value: '24' } });
    fireEvent.change(to, { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(api.setMode).toHaveBeenCalledWith({
        mode: 'dating',
        gender: 'g.woman',
        seeking: ['g.man'],
        ageMin: 24,
        ageMax: 35,
      }),
    );
  });

  it('does not let an invalid range through (below 18, or from above to)', async () => {
    const api = fakeApi({ getMe: vi.fn(() => ok(dating)) });
    const { from, to } = await openModeSettings(api);
    const next = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Сохранить' });
    fireEvent.change(from, { target: { value: '17' } });
    expect(next().disabled).toBe(true);
    fireEvent.change(from, { target: { value: '40' } });
    expect(next().disabled).toBe(true);
    fireEvent.change(to, { target: { value: '45' } });
    expect(next().disabled).toBe(false);
  });

  it('offers own age ±5 (never below 18) when switching from friends to dating', async () => {
    const api = fakeApi({
      getMe: vi.fn(() =>
        ok(
          me({
            ...dating,
            age: 20,
            mode: 'friends',
            gender: null,
            seeking: null,
            datingAgeMin: null,
            datingAgeMax: null,
          }),
        ),
      ),
    });
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Настройки' }));
    fireEvent.click(screen.getByRole('button', { name: 'Режим' }));
    fireEvent.click(screen.getByRole('button', { name: /Отношения/ }));
    expect((await screen.findByLabelText<HTMLInputElement>('от')).value).toBe('18');
    expect(screen.getByLabelText<HTMLInputElement>('до').value).toBe('25');
  });
});

describe('<App> done screen and write access', () => {
  it('requests write access when the bot may not message the user yet', async () => {
    const platform = fakePlatform({ allowsWriteToPm: () => false });
    renderWithI18n(
      <App
        api={fakeApi({ getMe: vi.fn(() => ok(me({ step: 'done', status: 'active' }))) })}
        platform={platform}
        today={TODAY}
      />,
    );
    expect(await screen.findByText('Профиль готов!')).toBeTruthy();
    await waitFor(() => expect(platform.requestWriteAccess).toHaveBeenCalledTimes(1));
  });

  it('does not ask when write access is already granted', async () => {
    const platform = fakePlatform({ allowsWriteToPm: () => true });
    renderWithI18n(
      <App
        api={fakeApi({ getMe: vi.fn(() => ok(me({ step: 'done', status: 'active' }))) })}
        platform={platform}
        today={TODAY}
      />,
    );
    expect(await screen.findByText('Профиль готов!')).toBeTruthy();
    expect(platform.requestWriteAccess).not.toHaveBeenCalled();
  });

  it('tells waitlisted u18 users they will be notified, and opens settings with the read-only birth date', async () => {
    const api = fakeApi({
      getMe: vi.fn(() =>
        ok(
          me({
            step: 'done',
            status: 'waitlisted',
            band: 'u18',
            birthDate: '2010-05-20',
            mode: 'friends',
          }),
        ),
      ),
    });
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} />);
    expect(
      await screen.findByText(
        'Скоро мы откроем SameSync для твоего возраста и сразу напишем в боте.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
    expect(screen.getByText('2010-05-20')).toBeTruthy();
    expect(screen.getByText(/назови код ABCDEFGH12/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Режим' })).toBeNull();
  });
});

describe('<App> matches', () => {
  const active = me({ step: 'done', status: 'active', band: 'adult', mode: 'friends' });
  const match = {
    id: '01a10238-d68a-76a8-87cc-960f650dd8c3',
    alias: { emoji: '🦊', name: 'Лиса' },
    teaser: 'У кого-то здесь в плейлисте тоже Молчат Дома.',
    status: 'pending_game' as const,
    createdAt: '2026-10-03T10:00:00.000Z',
    gameDeadlineAt: '2026-10-05T10:00:00.000Z',
    resultsReadyAt: null,
    chatDeadlineAt: null,
    game: { questions: 5, youDone: false, theyDone: false },
    chat: true,
  };

  it('lists the matches on the home screen with whose turn it is, and opens the match on its intro', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(active)),
      matches: vi.fn(() => ok({ matches: [match] })),
    });
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} />);
    expect(await screen.findByText('Знакомства')).toBeTruthy();
    expect(screen.getByText('У кого-то здесь в плейлисте тоже Молчат Дома.')).toBeTruthy();
    expect(screen.getByText('Твой ход')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Лиса/ }));
    expect(screen.getByRole('heading', { name: '🦊 Лиса' })).toBeTruthy();
    expect(
      screen.getByText(
        'Угадайте ответы друг друга: 5 карточек, а в конце — то, в чём вы разошлись.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Играть' })).toBeTruthy();
    // Already loaded with the list: no second request for the same match.
    expect(api.match).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByText('Профиль готов!')).toBeTruthy();
  });

  it('says on the home screen when a match waits for the other person or has results', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(active)),
      matches: vi.fn(() =>
        ok({
          matches: [
            { ...match, id: 'waiting', game: { questions: 5, youDone: true, theyDone: false } },
            {
              ...match,
              id: 'ready',
              status: 'results_ready' as const,
              game: { questions: 5, youDone: true, theyDone: true },
            },
          ],
        }),
      ),
    });
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} />);
    expect(await screen.findByText('Ждём ответный ход')).toBeTruthy();
    expect(screen.getByText('Результаты готовы')).toBeTruthy();
    expect(screen.queryByText('Твой ход')).toBeNull();
  });

  it('shows no matches section while there are none', async () => {
    const api = fakeApi({ getMe: vi.fn(() => ok(active)) });
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} />);
    expect(await screen.findByText('Профиль готов!')).toBeTruthy();
    await waitFor(() => expect(api.matches).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Знакомства')).toBeNull();
  });

  it('opens the match from the bot notification link, loading it by ID', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(active)),
      match: vi.fn(() => ok({ ...match, status: 'closed' as const, game: null })),
    });
    renderWithI18n(
      <App api={api} platform={fakePlatform()} today={TODAY} initialMatchId={match.id} />,
    );
    expect(await screen.findByRole('heading', { name: '🦊 Лиса' })).toBeTruthy();
    expect(api.match).toHaveBeenCalledWith(match.id);
    expect(screen.getByText('Это знакомство завершено.')).toBeTruthy();
  });

  it('says so when the linked match is not available, and goes back home', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(active)),
      match: vi.fn(() =>
        Promise.resolve({ kind: 'error' as const, code: 'not_found' as const, details: [] }),
      ),
    });
    renderWithI18n(<App api={api} platform={fakePlatform()} today={TODAY} initialMatchId="gone" />);
    expect(await screen.findByText('Это знакомство недоступно.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByText('Профиль готов!')).toBeTruthy();
  });

  it('asks for no matches while the user is waitlisted or still onboarding', async () => {
    const api = fakeApi({
      getMe: vi.fn(() => ok(me({ step: 'done', status: 'waitlisted', band: 'u18' }))),
    });
    renderWithI18n(
      <App api={api} platform={fakePlatform()} today={TODAY} initialMatchId={match.id} />,
    );
    expect(
      await screen.findByText(
        'Скоро мы откроем SameSync для твоего возраста и сразу напишем в боте.',
      ),
    ).toBeTruthy();
    expect(api.matches).not.toHaveBeenCalled();
    expect(api.match).not.toHaveBeenCalled();
  });
});

describe('a frozen or deleted account (Phase 5)', () => {
  it('shows a frozen account why, with no matches or settings', async () => {
    renderWithI18n(
      <App
        api={fakeApi({
          getMe: vi.fn(() =>
            ok(me({ step: 'done', status: 'frozen', band: 'adult', mode: 'friends' })),
          ),
        })}
        platform={fakePlatform()}
        today="2026-10-02"
      />,
    );
    expect(
      await screen.findByText(
        'Аккаунт заморожен: на него поступило несколько жалоб. Знакомства и чаты приостановлены. Если это ошибка, напиши в боте: /support и текст сообщения.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Настройки' })).toBeNull();
  });

  it('shows a deleted account that it is deleted', async () => {
    renderWithI18n(
      <App
        api={fakeApi({ getMe: vi.fn(() => ok(me({ step: 'done', status: 'deleted' }))) })}
        platform={fakePlatform()}
        today="2026-10-02"
      />,
    );
    expect(await screen.findByText('Аккаунт удалён.')).toBeTruthy();
  });
});
