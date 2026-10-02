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
