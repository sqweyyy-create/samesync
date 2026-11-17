import type { Locale } from '@samesync/shared';
import type {
  DeckResponse,
  InterestsResponse,
  MatchSummary,
  MeResponse,
  ResultsResponse,
} from '@samesync/shared/api';
import { createTranslator } from '@samesync/shared/i18n';
import { catalogs } from '@samesync/shared/i18n/static';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApiClient, ApiResult } from '../api/client';
import { App } from '../App';
import { I18nProvider } from '../i18n/I18nProvider';
import { PlatformProvider } from '../platform/context';
import type { Platform } from '../platform/types';

/**
 * Dev-only gallery: `/?preview=<screen>&theme=light|dark` renders the real app against fixture
 * data, so every screen can be looked at without a bot. Production builds never import this module.
 */
const MATCH_ID = '01a10238-d68a-76a8-87cc-960f650dd8c3';

function ok<T>(data: T): Promise<ApiResult<T>> {
  return Promise.resolve({ kind: 'ok', data });
}

function profile(over: Partial<MeResponse> = {}): MeResponse {
  return {
    publicId: 'K7M2QP91',
    firstName: 'Аня',
    locale: 'ru',
    status: 'onboarding',
    step: 'locale',
    birthDate: null,
    age: null,
    band: null,
    mode: null,
    gender: null,
    seeking: null,
    datingAgeMin: null,
    datingAgeMax: null,
    progress: { answered: 0, interests: 0 },
    ...over,
  };
}

const ACTIVE = profile({
  step: 'done',
  status: 'active',
  birthDate: '2010-04-02',
  age: 16,
  band: 'u18',
  mode: 'friends',
  progress: { answered: 28, interests: 7 },
});

function match(over: Partial<MatchSummary> = {}): MatchSummary {
  return {
    id: MATCH_ID,
    alias: { emoji: '🦊', name: 'Лиса' },
    teaser: 'У кого-то здесь в плейлисте тоже Молчат Дома.',
    status: 'pending_game',
    createdAt: '2026-11-16T10:00:00.000Z',
    gameDeadlineAt: '2026-11-19T15:00:00.000Z',
    resultsReadyAt: null,
    chatDeadlineAt: null,
    game: { questions: 3, youDone: false, theyDone: false },
    chat: true,
    ...over,
  };
}

const HOME_MATCHES: MatchSummary[] = [
  match(),
  match({
    id: '01a10238-d68a-76a8-87cc-960f650dd8c4',
    alias: { emoji: '🦦', name: 'Выдра' },
    teaser: 'Вы оба считаете, что ананас на пицце — это нормально.',
    game: { questions: 3, youDone: true, theyDone: false },
  }),
  match({
    id: '01a10238-d68a-76a8-87cc-960f650dd8c5',
    alias: { emoji: '🐸', name: 'Лягушка' },
    teaser: 'Оба смотрите одно шоу и разошлись в одном финале.',
    status: 'results_ready',
    resultsReadyAt: '2026-11-17T09:00:00.000Z',
    chatDeadlineAt: '2026-11-19T09:00:00.000Z',
    game: { questions: 3, youDone: true, theyDone: true },
  }),
];

const TAKES = [
  { id: 'q.a', text: 'Ананас на пицце — это нормально' },
  { id: 'q.b', text: 'Спойлер в тот же день — преступление' },
  { id: 'q.c', text: 'Лучшие мемы живут одну неделю' },
];

const RESULTS: ResultsResponse = {
  total: 3,
  youGuessed: 2,
  theyGuessed: 1,
  rounds: [
    {
      questionId: 'q.a',
      text: 'Ананас на пицце — это нормально',
      yours: 'agree',
      theirs: 'agree',
      yourGuess: 'agree',
      theirGuess: 'disagree',
    },
    {
      questionId: 'q.b',
      text: 'Спойлер в тот же день — преступление',
      yours: 'disagree',
      theirs: 'disagree',
      yourGuess: 'agree',
      theirGuess: 'disagree',
    },
    {
      questionId: 'q.c',
      text: 'Лучшие мемы живут одну неделю',
      yours: 'agree',
      theirs: 'disagree',
      yourGuess: 'disagree',
      theirGuess: 'disagree',
    },
  ],
  opener: 'Я за. А ты почему против?',
};

const DECK: DeckResponse = {
  questions: [
    { id: 'q.1', text: 'Учёба ночью продуктивнее, чем утром' },
    { id: 'q.2', text: 'Сериал можно бросить на середине' },
    { id: 'q.3', text: 'Голосовые сообщения — это удобно' },
    { id: 'q.4', text: 'Лучший план на выходные — никуда не идти' },
    { id: 'q.5', text: 'Мемы объясняют жизнь точнее новостей' },
    { id: 'q.6', text: 'Пицца с ананасом — это нормально' },
  ],
  answers: [{ questionId: 'q.1', value: 'agree' }],
};

const INTERESTS: InterestsResponse = {
  items: [
    { id: 'i.1', name: 'Молчат Дома', categoryName: 'Инди', domain: 'music' },
    { id: 'i.2', name: 'Кино', categoryName: 'Русский рок', domain: 'music' },
    { id: 'i.3', name: 'Stardew Valley', categoryName: 'Уютные', domain: 'games' },
    { id: 'i.4', name: 'Minecraft', categoryName: 'Песочницы', domain: 'games' },
    { id: 'i.5', name: 'Очень странные дела', categoryName: 'Сериалы', domain: 'shows' },
    { id: 'i.6', name: 'Смешарики', categoryName: 'Мультфильмы', domain: 'shows' },
    { id: 'i.7', name: 'Кот в сапогах', categoryName: 'Мемы', domain: 'memes' },
    { id: 'i.8', name: 'Гарри Поттер', categoryName: 'Книги', domain: 'books' },
  ],
  selected: ['i.1', 'i.3', 'i.5', 'i.7', 'i.8'],
};

function meFor(screen: string): MeResponse {
  switch (screen) {
    case 'birth-date':
      return profile({ step: 'birth_date' });
    case 'mode':
    case 'dating':
      return profile({
        step: 'mode',
        status: 'onboarding',
        birthDate: '2004-03-12',
        age: 22,
        band: 'adult',
        mode: screen === 'dating' ? 'dating' : null,
        gender: screen === 'dating' ? 'g.woman' : null,
        seeking: screen === 'dating' ? ['g.man'] : null,
      });
    case 'deck':
      return profile({
        step: 'answers',
        band: 'u18',
        mode: 'friends',
        birthDate: '2010-04-02',
        age: 16,
      });
    case 'interests':
      return profile({
        step: 'interests',
        band: 'u18',
        mode: 'friends',
        birthDate: '2010-04-02',
        age: 16,
        progress: { answered: 28, interests: 5 },
      });
    case 'waitlist':
      return profile({
        step: 'done',
        status: 'waitlisted',
        band: 'u18',
        mode: 'friends',
        birthDate: '2010-04-02',
        age: 16,
      });
    case 'ineligible':
      return profile({ step: 'ineligible', status: 'ineligible' });
    case 'frozen':
      return profile({ step: 'done', status: 'frozen', band: 'u18', mode: 'friends' });
    case 'deleted':
      return profile({ step: 'done', status: 'deleted' });
    case 'home':
    case 'home-empty':
    case 'access':
    case 'match':
    case 'waiting':
    case 'results':
    case 'ended':
    case 'settings':
      return ACTIVE;
    default:
      return profile({ step: 'locale' });
  }
}

function currentMatch(screen: string): MatchSummary {
  if (screen === 'waiting')
    return match({ game: { questions: 3, youDone: true, theyDone: false } });
  if (screen === 'results') {
    return match({
      status: 'results_ready',
      resultsReadyAt: '2026-11-17T09:00:00.000Z',
      chatDeadlineAt: '2026-11-19T09:00:00.000Z',
      game: { questions: 3, youDone: true, theyDone: true },
    });
  }
  if (screen === 'ended') return match({ status: 'expired', game: null });
  return match();
}

function previewApi(screen: string): ApiClient {
  const me = meFor(screen);
  const opened = currentMatch(screen);
  const interests = (filter: { domain?: string; q?: string }) => {
    const query = filter.q?.trim().toLowerCase();
    const items = INTERESTS.items.filter((item) => {
      if (filter.domain && item.domain !== filter.domain) return false;
      if (query && !item.name.toLowerCase().includes(query)) return false;
      return true;
    });
    return ok({ items, selected: INTERESTS.selected });
  };
  return {
    getMe: () => (screen === 'error' ? Promise.resolve({ kind: 'network' }) : ok(me)),
    setLocale: (locale: Locale) => ok({ ...me, locale }),
    setBirthDate: () => ok(me),
    setMode: () => ok(me),
    datingOptions: () =>
      ok({
        options: [
          { id: 'g.man', self: 'Мужчина', seeking: 'Мужчин' },
          { id: 'g.woman', self: 'Женщина', seeking: 'Женщин' },
          { id: 'g.nonbinary', self: 'Небинарный человек', seeking: 'Небинарных людей' },
        ],
      }),
    deck: () => ok(DECK),
    saveAnswers: () => ok(me),
    interests,
    saveInterests: () => ok({ ...ACTIVE, step: 'done' }),
    complete: () => ok(ACTIVE),
    matches: () => ok({ matches: screen === 'home' || screen === 'settings' ? HOME_MATCHES : [] }),
    match: () => ok(opened),
    game: () => ok({ questions: TAKES }),
    submitPredictions: () => ok(match({ game: { questions: 3, youDone: true, theyDone: false } })),
    results: () => ok(RESULTS),
    sendMessage: () => ok({ ...opened, status: 'active', chatDeadlineAt: null }),
    report: () => ok({ status: 'stored' }),
    block: () => ok({ ...opened, status: 'closed', game: null }),
  };
}

function previewPlatform(inTelegram: boolean): Platform {
  return {
    inTelegram,
    initDataRaw: () => (inTelegram ? 'preview' : undefined),
    languageCode: () => 'ru',
    ready: () => undefined,
    allowsWriteToPm: () => true,
    requestWriteAccess: () => Promise.resolve(true),
    close: () => undefined,
    nativeButtons: false,
    setMainButton: () => undefined,
    setBackButton: () => undefined,
    haptic: () => undefined,
  };
}

const OPEN_MATCH = new Set(['match', 'waiting', 'results', 'ended']);

export function mountPreview(
  root: HTMLElement,
  { screen, theme }: { screen: string; theme: 'light' | 'dark' },
): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.lang = 'ru';
  const platform = previewPlatform(screen !== 'outside');
  const translator = createTranslator('ru', catalogs.ru);
  createRoot(root).render(
    <StrictMode>
      <PlatformProvider platform={platform}>
        <I18nProvider
          translator={translator}
          loadCatalog={(locale) => Promise.resolve(catalogs[locale])}
        >
          <App
            api={previewApi(screen)}
            platform={platform}
            today="2026-11-17"
            initialMatchId={OPEN_MATCH.has(screen) ? MATCH_ID : undefined}
          />
        </I18nProvider>
      </PlatformProvider>
    </StrictMode>,
  );
}
