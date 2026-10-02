import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithI18n } from '../test-utils';
import { BirthDate } from './BirthDate';

afterEach(cleanup);
const TODAY = '2026-10-03';

function setup(locale: 'ru' | 'en' = 'ru') {
  const onConfirm = vi.fn();
  renderWithI18n(<BirthDate today={TODAY} busy={false} onConfirm={onConfirm} />, locale);
  const input = screen.getByLabelText(locale === 'ru' ? 'Дата рождения' : 'Birth date');
  const enter = (value: string) => fireEvent.change(input, { target: { value } });
  const next = () =>
    fireEvent.click(screen.getByRole('button', { name: locale === 'ru' ? 'Дальше' : 'Next' }));
  return { onConfirm, enter, next };
}

describe('<BirthDate>', () => {
  it('keeps Next disabled until a date is entered', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Дальше' }).hasAttribute('disabled')).toBe(true);
  });

  it('rejects a future date and an implausible year without calling the API', () => {
    const { onConfirm, enter, next } = setup();
    enter('2026-12-01');
    next();
    expect(screen.getByRole('alert').textContent).toBe('Эта дата ещё не наступила.');
    enter('1890-01-01');
    next();
    expect(screen.getByRole('alert').textContent).toBe('Проверь год рождения.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('asks to confirm the computed age with the right Russian plural, then submits', () => {
    const { onConfirm, enter, next } = setup();
    enter('2010-05-20');
    next();
    expect(screen.getByRole('heading', { name: 'Тебе 16 лет — верно?' })).toBeTruthy();
    expect(screen.getByText('После подтверждения дату рождения изменить нельзя.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Да, верно' }));
    expect(onConfirm).toHaveBeenCalledWith('2010-05-20');
  });

  it('lets the user go back and fix the date before confirming', () => {
    const { onConfirm, enter, next } = setup();
    enter('2005-01-01');
    next();
    expect(screen.getByRole('heading', { name: 'Тебе 21 год — верно?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Исправить' }));
    expect(screen.getByLabelText('Дата рождения')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('works in English', () => {
    const { enter, next } = setup('en');
    enter('2008-01-01');
    next();
    expect(screen.getByRole('heading', { name: "You're 18 — right?" })).toBeTruthy();
  });
});
