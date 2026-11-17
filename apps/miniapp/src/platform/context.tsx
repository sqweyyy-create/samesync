import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { Platform } from './types';

/** Used when a component renders outside `<PlatformProvider>` (unit tests, and a missing mount). */
const INERT_PLATFORM: Platform = {
  inTelegram: false,
  initDataRaw: () => undefined,
  languageCode: () => undefined,
  ready: () => undefined,
  allowsWriteToPm: () => undefined,
  requestWriteAccess: () => Promise.resolve(false),
  close: () => undefined,
  nativeButtons: false,
  setMainButton: () => undefined,
  setBackButton: () => undefined,
  haptic: () => undefined,
};

const PlatformContext = createContext<Platform>(INERT_PLATFORM);

interface BackEntry {
  id: string;
  fn: () => void;
}

interface MainEntry {
  id: string;
  text: string;
  disabled: boolean;
  loading: boolean;
  fn: () => void;
}

interface ChromeStack {
  pushBack: (id: string, fn: () => void) => void;
  popBack: (id: string) => void;
  pushMain: (entry: MainEntry) => void;
  popMain: (id: string) => void;
}

const ChromeContext = createContext<ChromeStack | null>(null);

/**
 * Shares the Telegram platform and a stack of back actions. The top of the stack is the native
 * BackButton: a screen pushed later (the game inside a match) wins until it unmounts.
 */
export function PlatformProvider({
  platform,
  children,
}: {
  platform: Platform;
  children: ReactNode;
}) {
  const backs = useRef<BackEntry[]>([]);
  const mains = useRef<MainEntry[]>([]);
  const chrome = useMemo<ChromeStack>(() => {
    const syncBack = () => {
      const top = backs.current.at(-1);
      platform.setBackButton(top ? () => top.fn() : null);
    };
    const syncMain = () => {
      const top = mains.current.at(-1);
      platform.setMainButton(
        top
          ? {
              text: top.text,
              disabled: top.disabled,
              loading: top.loading,
              onClick: () => top.fn(),
            }
          : null,
      );
    };
    return {
      pushBack(id, fn) {
        const existing = backs.current.find((entry) => entry.id === id);
        if (existing) {
          existing.fn = fn;
          return;
        }
        backs.current.push({ id, fn });
        syncBack();
      },
      popBack(id) {
        const next = backs.current.filter((entry) => entry.id !== id);
        if (next.length === backs.current.length) return;
        backs.current = next;
        syncBack();
      },
      pushMain(entry) {
        const existing = mains.current.find((item) => item.id === entry.id);
        if (existing) {
          existing.text = entry.text;
          existing.disabled = entry.disabled;
          existing.loading = entry.loading;
          existing.fn = entry.fn;
          syncMain();
          return;
        }
        mains.current.push(entry);
        syncMain();
      },
      popMain(id) {
        const next = mains.current.filter((entry) => entry.id !== id);
        if (next.length === mains.current.length) return;
        mains.current = next;
        syncMain();
      },
    };
  }, [platform]);
  return (
    <PlatformContext.Provider value={platform}>
      <ChromeContext.Provider value={chrome}>{children}</ChromeContext.Provider>
    </PlatformContext.Provider>
  );
}

export function usePlatform(): Platform {
  return useContext(PlatformContext);
}

export function useChromeStack(): ChromeStack | null {
  return useContext(ChromeContext);
}
