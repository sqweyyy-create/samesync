// The ONLY module that imports the Telegram SDK (CLAUDE.md, Mini App conventions).
import {
  init,
  isTMA,
  miniApp,
  mockTelegramEnv,
  requestWriteAccess,
  retrieveRawInitData,
  themeParams,
} from '@tma.js/sdk-react';
import { allowsWriteToPmFromInitData, languageCodeFromInitData, type Platform } from './types';

const OUTSIDE_TELEGRAM: Platform = {
  inTelegram: false,
  initDataRaw: () => undefined,
  languageCode: () => navigator.language,
  ready: () => undefined,
  allowsWriteToPm: () => undefined,
  requestWriteAccess: () => Promise.resolve(false),
};

/**
 * Dev-only: lets the app run in a normal browser with launch params from `pnpm dev:initdata`
 * (they are in the URL hash). The initData is still signed and validated by the server.
 * `import.meta.env.DEV` is false in production builds, so this branch is removed from the bundle.
 */
function mockBrowserEnvInDev(): void {
  if (!import.meta.env.DEV) return;
  // A real Telegram client either injects TelegramWebviewProxy (apps) or embeds us in an iframe (web).
  const inRealTelegram = 'TelegramWebviewProxy' in window || window.parent !== window;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (inRealTelegram || !hash.has('tgWebAppData')) return;
  mockTelegramEnv({ launchParams: hash, onEvent: () => undefined });
}

export function createTelegramPlatform(): Platform {
  mockBrowserEnvInDev();
  if (!isTMA()) return OUTSIDE_TELEGRAM;

  init();
  themeParams.mount.ifAvailable();
  // Exposes Telegram's palette as --tg-theme-* CSS variables (used by ui/base.css).
  themeParams.bindCssVars.ifAvailable();
  miniApp.mount.ifAvailable();

  const raw = retrieveRawInitData();
  return {
    inTelegram: true,
    initDataRaw: () => raw,
    languageCode: () => languageCodeFromInitData(raw),
    ready: () => void miniApp.ready.ifAvailable(),
    allowsWriteToPm: () => allowsWriteToPmFromInitData(raw),
    async requestWriteAccess() {
      if (!requestWriteAccess.isAvailable()) return false;
      try {
        return (await requestWriteAccess()) === 'allowed';
      } catch {
        return false;
      }
    },
  };
}
