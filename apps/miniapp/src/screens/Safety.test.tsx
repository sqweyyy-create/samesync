import type { MatchSummary } from '@samesync/shared/api';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, ok, renderWithI18n } from '../test-utils';
import { Safety } from './Safety';

afterEach(cleanup);

const ID = '01a10238-d68a-76a8-87cc-960f650dd8c3';
const CLOSED: MatchSummary = {
  id: ID,
  alias: { emoji: '🦊', name: 'Лиса' },
  teaser: 'teaser',
  status: 'closed',
  createdAt: '2026-10-04T10:00:00.000Z',
  gameDeadlineAt: '2026-10-06T10:00:00.000Z',
  resultsReadyAt: null,
  chatDeadlineAt: null,
  game: null,
  chat: true,
};
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('<Safety>', () => {
  it('reports with a reason and a note, once', async () => {
    const report = vi.fn(() => ok({ status: 'stored' as const }));
    renderWithI18n(
      <Safety api={fakeApi({ report })} match={{ id: ID }} alias="🦊 Лиса" onBlocked={vi.fn()} />,
    );
    click('Пожаловаться');
    expect(screen.getByRole('heading', { name: 'Что не так?' })).toBeTruthy();
    // Nothing is sent before a reason is picked.
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить жалобу' }).disabled,
    ).toBe(true);
    click('Просит контакты или даёт свои');
    fireEvent.change(screen.getByLabelText('Комментарий (необязательно)'), {
      target: { value: 'просит номер' },
    });
    click('Отправить жалобу');
    expect(await screen.findByText('Спасибо, жалоба принята. Мы разберёмся.')).toBeTruthy();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(ID, { reason: 'contact_sharing', note: 'просит номер' });
    expect(screen.queryByRole('button', { name: 'Пожаловаться' })).toBeNull();
  });

  it('says so when the match was reported before, and keeps the form when sending fails', async () => {
    const report = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'network' })
      .mockResolvedValueOnce({ kind: 'ok', data: { status: 'duplicate' } });
    renderWithI18n(
      <Safety api={fakeApi({ report })} match={{ id: ID }} alias="🦊 Лиса" onBlocked={vi.fn()} />,
    );
    click('Пожаловаться');
    click('Спам или реклама');
    click('Отправить жалобу');
    expect(
      await screen.findByText('Не получилось отправить жалобу. Попробуй ещё раз.'),
    ).toBeTruthy();
    click('Отправить жалобу');
    expect(
      await screen.findByText('Жалоба на это знакомство уже есть. Мы разберёмся.'),
    ).toBeTruthy();
    expect(report).toHaveBeenLastCalledWith(ID, { reason: 'spam' });
  });

  it('blocks after one confirmation and hands the closed match back', async () => {
    const block = vi.fn(() => ok(CLOSED));
    const onBlocked = vi.fn();
    renderWithI18n(
      <Safety api={fakeApi({ block })} match={{ id: ID }} alias="🦊 Лиса" onBlocked={onBlocked} />,
    );
    click('Заблокировать');
    expect(
      screen.getByText(
        'Заблокировать 🦊 Лиса? Чат завершится, и вы больше не встретитесь. Отменить это будет нельзя.',
      ),
    ).toBeTruthy();
    expect(block).not.toHaveBeenCalled();
    click('Отмена');
    expect(screen.getByRole('button', { name: 'Заблокировать' })).toBeTruthy();
    click('Заблокировать');
    click('Заблокировать');
    expect(
      await screen.findByText('Готово. Это знакомство завершено, и вы больше не встретитесь.'),
    ).toBeTruthy();
    expect(block).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onBlocked).toHaveBeenCalledWith(CLOSED));
  });
});
