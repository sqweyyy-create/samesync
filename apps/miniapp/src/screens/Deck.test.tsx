import type { AnswerValue, DeckResponse } from '@samesync/shared/api';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, me, ok, renderWithI18n } from '../test-utils';
import { Deck } from './Deck';

afterEach(cleanup);

const questions = Array.from({ length: 35 }, (_, i) => ({ id: `q.t${i}`, text: `Take ${i}` }));

function setup(answers: DeckResponse['answers'] = []) {
  const saved: Array<{ questionId: string; value: AnswerValue }> = [];
  const api = fakeApi({
    deck: vi.fn(() => ok({ questions, answers })),
    saveAnswers: vi.fn((entries: Array<{ questionId: string; value: AnswerValue }>) => {
      saved.push(...entries);
      return ok(me({ step: 'answers' }));
    }),
  });
  const onDone = vi.fn();
  renderWithI18n(<Deck api={api} onDone={onDone} onError={() => undefined} />);
  const press = async (name: string) => {
    fireEvent.click(await screen.findByRole('button', { name }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'За' }).hasAttribute('disabled')).toBe(false),
    );
  };
  return { saved, onDone, press };
}

describe('<Deck>', () => {
  it('saves agree, disagree and skip, and shows progress', async () => {
    const { saved, press } = setup();
    expect(await screen.findByText('Take 0')).toBeTruthy();
    expect(screen.getByText('1 из 35')).toBeTruthy();
    await press('За');
    await press('Против');
    await press('Пропустить');
    expect(saved).toEqual([
      { questionId: 'q.t0', value: 'agree' },
      { questionId: 'q.t1', value: 'disagree' },
      { questionId: 'q.t2', value: 'skip' },
    ]);
    expect(screen.getByText('Take 3')).toBeTruthy();
    expect(screen.getByText('4 из 35')).toBeTruthy();
  });

  it('"Back" returns to the previous card so its answer can be changed', async () => {
    const { saved, press } = setup();
    await screen.findByText('Take 0');
    expect(screen.getByRole('button', { name: 'Назад' }).hasAttribute('disabled')).toBe(true);
    await press('За');
    await press('Назад');
    expect(screen.getByText('Take 0')).toBeTruthy();
    await press('Против');
    expect(saved.at(-1)).toEqual({ questionId: 'q.t0', value: 'disagree' });
    expect(screen.getByText('Take 1')).toBeTruthy();
  });

  it('resumes at the first unanswered card', async () => {
    setup([
      { questionId: 'q.t0', value: 'agree' },
      { questionId: 'q.t1', value: 'skip' },
    ]);
    expect(await screen.findByText('Take 2')).toBeTruthy();
  });

  it('brings skipped cards back when fewer than 25 were answered, then finishes', async () => {
    const already: DeckResponse['answers'] = questions
      .slice(0, 34)
      .map((q, i) => ({ questionId: q.id, value: i < 23 ? 'agree' : 'skip' }));
    const { onDone, press } = setup(already);
    expect(await screen.findByText('Take 34')).toBeTruthy();
    await press('За');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByText('Ответов пока 24 из 25. Давай вернёмся к пропущенным.')).toBeTruthy();
    expect(screen.getByText('Take 23')).toBeTruthy();
    await press('Против');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
