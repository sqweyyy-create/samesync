import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider } from '../platform/context';
import { fakePlatform, renderWithI18n } from '../test-utils';
import { PrimaryButton, useBackButton } from './chrome';

afterEach(cleanup);

function BackProbe({ onBack, label }: { onBack: () => void; label: string }) {
  useBackButton(onBack);
  return <p>{label}</p>;
}

describe('Telegram chrome', () => {
  it('mirrors the primary action onto the native main button and keeps the in-page button', () => {
    const setMainButton = vi.fn();
    renderWithI18n(
      <PlatformProvider platform={fakePlatform({ setMainButton })}>
        <PrimaryButton onClick={() => undefined}>Дальше</PrimaryButton>
      </PlatformProvider>,
    );
    expect(screen.getByRole('button', { name: 'Дальше' })).toBeTruthy();
    expect(setMainButton).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Дальше', disabled: false, loading: false }),
    );
  });

  it('hides the in-page button when Telegram is already showing its own', () => {
    const setMainButton = vi.fn();
    renderWithI18n(
      <PlatformProvider platform={fakePlatform({ nativeButtons: true, setMainButton })}>
        <PrimaryButton onClick={() => undefined}>Дальше</PrimaryButton>
      </PlatformProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Дальше' })).toBeNull();
    expect(setMainButton).toHaveBeenCalled();
  });

  it('gives the native back button to the screen that was opened last', () => {
    const setBackButton = vi.fn();
    const outer = vi.fn();
    const inner = vi.fn();
    function Stack() {
      const [open, setOpen] = useState(true);
      return (
        <PlatformProvider platform={fakePlatform({ setBackButton })}>
          <BackProbe label="outer" onBack={outer} />
          {open && <BackProbe label="inner" onBack={inner} />}
          <button type="button" onClick={() => setOpen(false)}>
            close
          </button>
        </PlatformProvider>
      );
    }
    render(<Stack />);
    const top = setBackButton.mock.calls.at(-1)?.[0] as (() => void) | null;
    top?.();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    const next = setBackButton.mock.calls.at(-1)?.[0] as (() => void) | null;
    next?.();
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
