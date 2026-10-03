import { resolveLocale, utcDate } from '@samesync/shared';
import { createTranslator } from '@samesync/shared/i18n';
import { loadCatalog } from '@samesync/shared/i18n/load';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api/client';
import { App } from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { createTelegramPlatform } from './platform/telegram';
import './ui/base.css';

const platform = createTelegramPlatform();
// Telegram's language only covers the first paint; the stored locale takes over (Q13).
const initialLocale = resolveLocale(platform.languageCode());
const translator = createTranslator(initialLocale, await loadCatalog(initialLocale));
const api = createApiClient({ getInitData: () => platform.initDataRaw() });

document.documentElement.lang = initialLocale;
// The bot's "new match" button opens the Mini App with ?match=<id>.
const initialMatchId = new URLSearchParams(window.location.search).get('match') ?? undefined;
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider translator={translator} loadCatalog={loadCatalog}>
      <App
        api={api}
        platform={platform}
        today={utcDate(new Date())}
        initialMatchId={initialMatchId}
      />
    </I18nProvider>
  </StrictMode>,
);
platform.ready();
