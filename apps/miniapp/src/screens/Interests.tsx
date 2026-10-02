import { ONBOARDING, type InterestsResponse, type MeResponse } from '@samesync/shared/api';
import type { MessageKey } from '@samesync/shared/i18n';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Choice, Screen } from '../ui/Screen';

type Item = InterestsResponse['items'][number];

/** Domain tabs. Adding a domain is a schema change, so the list lives with the UI strings. */
const DOMAIN_LABELS: Record<string, MessageKey> = {
  music: 'miniapp.domain.music',
  games: 'miniapp.domain.games',
  shows: 'miniapp.domain.shows',
  movies: 'miniapp.domain.movies',
  books: 'miniapp.domain.books',
  memes: 'miniapp.domain.memes',
};

const SEARCH_DELAY_MS = 250;

/** Interest picker (Q6): catalog only, 5–30 picks, domain tabs and server-side search. */
export function Interests({
  api,
  onDone,
  onError,
}: {
  api: ApiClient;
  onDone: (me: MeResponse) => void;
  onError: () => void;
}) {
  const t = useT();
  const [domain, setDomain] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const timer = setTimeout(
      () => {
        void api
          .interests({
            ...(domain ? { domain } : {}),
            ...(query.trim() ? { q: query.trim() } : {}),
          })
          .then((result) => {
            if (result.kind !== 'ok') return onError();
            setItems(result.data.items);
            setSelected((current) => current ?? result.data.selected);
          });
      },
      query ? SEARCH_DELAY_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [api, domain, query, onError]);

  const picked = selected ?? [];
  const toggle = (id: string) =>
    setSelected((current) => {
      const list = current ?? [];
      if (list.includes(id)) return list.filter((x) => x !== id);
      return list.length < ONBOARDING.maxInterests ? [...list, id] : list;
    });

  const save = async () => {
    setSaving(true);
    const result = await api.saveInterests(picked);
    setSaving(false);
    if (result.kind !== 'ok') return onError();
    onDone(result.data);
  };

  return (
    <Screen
      title={t('miniapp.interests.title')}
      hint={t('miniapp.interests.hint', {
        min: ONBOARDING.minInterests,
        max: ONBOARDING.maxInterests,
      })}
    >
      <input
        type="search"
        className="search"
        placeholder={t('miniapp.interests.search')}
        aria-label={t('miniapp.interests.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="tabs" role="tablist">
        <Choice selected={domain === undefined} onClick={() => setDomain(undefined)}>
          {t('miniapp.interests.all')}
        </Choice>
        {Object.entries(DOMAIN_LABELS).map(([id, key]) => (
          <Choice key={id} selected={domain === id} onClick={() => setDomain(id)}>
            {t(key)}
          </Choice>
        ))}
      </div>
      {items === null && <p className="hint">{t('miniapp.status.loading')}</p>}
      {items?.length === 0 && <p className="hint">{t('miniapp.interests.empty')}</p>}
      <div className="chips">
        {items?.map((item) => (
          <Choice
            key={item.id}
            selected={picked.includes(item.id)}
            onClick={() => toggle(item.id)}
            hint={item.categoryName}
            disabled={!picked.includes(item.id) && picked.length >= ONBOARDING.maxInterests}
          >
            {item.name}
          </Choice>
        ))}
      </div>
      <footer className="sticky">
        <span>
          {t('miniapp.interests.count', { count: picked.length, max: ONBOARDING.maxInterests })}
        </span>
        <button
          type="button"
          disabled={
            saving ||
            picked.length < ONBOARDING.minInterests ||
            picked.length > ONBOARDING.maxInterests
          }
          onClick={() => void save()}
        >
          {t('miniapp.action.done')}
        </button>
      </footer>
    </Screen>
  );
}
