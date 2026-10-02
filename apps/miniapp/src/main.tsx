import { resolveLocale } from '@samesync/shared';
import { createTranslator } from '@samesync/shared/i18n';
import { loadCatalog } from '@samesync/shared/i18n/load';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api/client';
import { I18nProvider } from './i18n/I18nProvider';
import { createTelegramPlatform } from './platform/telegram';
import { Hello } from './screens/Hello';
import './ui/base.css';

const platform = createTelegramPlatform();
const locale = resolveLocale(platform.languageCode());
const translator = createTranslator(locale, await loadCatalog(locale));
const api = createApiClient({ getInitData: () => platform.initDataRaw() });

document.documentElement.lang = locale;
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider translator={translator}>
      <Hello api={api} inTelegram={platform.inTelegram} />
    </I18nProvider>
  </StrictMode>,
);
platform.ready();
