// The ONLY module that imports the Telegram SDK (CLAUDE.md, Mini App conventions).
import {
  backButton,
  hapticFeedback,
  init,
  isTMA,
  mainButton,
  miniApp,
  mockTelegramEnv,
  requestWriteAccess,
  retrieveRawInitData,
  themeParams,
  viewport,
} from '@tma.js/sdk-react';
import {
  allowsWriteToPmFromInitData,
  languageCodeFromInitData,
  type HapticKind,
  type MainButtonState,
  type Platform,
} from './types';

const OUTSIDE_TELEGRAM: Platform = {
  inTelegram: false,
  initDataRaw: () => undefined,
  languageCode: () => navigator.language,
  ready: () => undefined,
  allowsWriteToPm: () => undefined,
  requestWriteAccess: () => Promise.resolve(false),
  close: () => undefined,
  nativeButtons: false,
  setMainButton: () => undefined,
  setBackButton: () => undefined,
  haptic: () => undefined,
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

/** Our extra tones follow the client's light/dark; themeParams CSS vars cover the surfaces. */
function syncColorScheme(): void {
  if (!themeParams.isMounted()) return;
  const dark = themeParams.isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/** Header, page and bottom bar track the theme keys, so a theme change repaints them. */
function bindChromeColors(): void {
  miniApp.setHeaderColor.ifAvailable('bg_color');
  miniApp.setBgColor.ifAvailable('bg_color');
  miniApp.setBottomBarColor.ifAvailable('bottom_bar_bg_color');
}

function mountViewport(): void {
  const mounted = viewport.mount.ifAvailable();
  const afterMount = () => {
    viewport.expand.ifAvailable();
    viewport.bindCssVars.ifAvailable();
  };
  if (mounted.ok) void Promise.resolve(mounted.data).then(afterMount);
  else afterMount();
}

export function createTelegramPlatform(): Platform {
  mockBrowserEnvInDev();
  if (!isTMA()) return OUTSIDE_TELEGRAM;

  init();
  themeParams.mount.ifAvailable();
  // Exposes Telegram's palette as --tg-theme-* CSS variables (used by ui/base.css).
  themeParams.bindCssVars.ifAvailable();
  if (themeParams.isMounted()) {
    syncColorScheme();
    themeParams.isDark.sub(() => syncColorScheme());
  }
  miniApp.mount.ifAvailable();
  bindChromeColors();
  mountViewport();

  mainButton.mount.ifAvailable();
  backButton.mount.ifAvailable();
  const nativeButtons = mainButton.isMounted();
  if (nativeButtons) document.documentElement.dataset.nativeMain = 'true';

  let mainClick: (() => void) | null = null;
  let backClick: (() => void) | null = null;
  mainButton.onClick.ifAvailable(() => mainClick?.());
  backButton.onClick.ifAvailable(() => backClick?.());

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
    close: () => void miniApp.close.ifAvailable(),
    nativeButtons,
    setMainButton(state: MainButtonState | null) {
      if (!nativeButtons) return;
      if (!state) {
        mainClick = null;
        mainButton.hide.ifAvailable();
        return;
      }
      mainClick = state.onClick;
      mainButton.setParams.ifAvailable({
        text: state.text,
        isVisible: true,
        isEnabled: !state.disabled && !state.loading,
        isLoaderVisible: state.loading,
      });
      mainButton.show.ifAvailable();
    },
    setBackButton(onClick) {
      backClick = onClick;
      if (onClick) backButton.show.ifAvailable();
      else backButton.hide.ifAvailable();
    },
    haptic(kind: HapticKind) {
      if (kind === 'select') hapticFeedback.selectionChanged.ifAvailable();
      else if (kind === 'light') hapticFeedback.impactOccurred.ifAvailable('light');
      else if (kind === 'success') hapticFeedback.notificationOccurred.ifAvailable('success');
      else if (kind === 'warning') hapticFeedback.notificationOccurred.ifAvailable('warning');
      else hapticFeedback.notificationOccurred.ifAvailable('error');
    },
  };
}
