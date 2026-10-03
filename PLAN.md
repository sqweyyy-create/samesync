# SameSync — Implementation Plan

Last updated: 2026-10-03. Project context and the non-negotiable safety rules are in [CLAUDE.md](CLAUDE.md).

## Status

| Phase | Title | Status |
|---|---|---|
| 0 | Scaffold | done (2026-10-03) |
| 1 | Onboarding | done (2026-10-03) |
| 2 | Matching engine | not started |
| 3 | Game | not started |
| 4 | Anonymous chat | not started |
| 5 | Safety & admin | not started |
| 6 | Payments, limits, visual pass, deploy | not started |

How to read this plan:
- Phases run in order. Don't start a phase until the previous one meets every acceptance criterion and CI is green.
- *Provisional* marks a default picked only to keep work moving. It holds until the matching open question in §8 is answered, and it must be easy to change (usually a config value or a content entry).
- Every phase keeps all earlier tests green. A phase isn't done if any test is red, skipped or weakened.

---

## 1. Glossary

| Term | Meaning |
|---|---|
| **Band** | Age band from `birth_date`: `u18` (14–17) or `adult` (18+). This is the hard isolation boundary. |
| **Locale** | `ru` or `en`. Users match only within their own locale. |
| **Pool** | Band × locale, e.g. `u18:ru`. Matching and rarity statistics are computed per pool. |
| **Mode** | `friends` or `dating`. `dating` exists only in the adult band. Matching runs per pool × mode. |
| **Take** | One agree/disagree "hot take" statement from the question bank. |
| **Swipe profile** | A user's take answers plus their interest picks. It is the whole profile. |
| **Feature** | One thing two users can share: an interest item, an interest category or domain (fallback tiers only), or a take answer such as `q.pineapple_pizza:agree`. |
| **Tier** | How broad an overlap may be: 1 niche, 2 related, 3 broad. |
| **Match** | A pair from one pool and mode. Its lifecycle is `pending_game → results_ready → active → expired / closed`. |
| **Alias** | The per-match anonymous display name (e.g. "🟣 Выдра"). |
| **Opener** | The pre-generated first message, built from the disagreement the game ends on. |
| **Outbox** | A DB table of pending bot messages. A throttled sender delivers them after re-checking safety. |

## 2. Architecture and technical decisions

```
Telegram clients
  │ bot updates (polling in dev, webhook in prod)     │ Mini App over HTTPS, "Authorization: tma <initData>"
  ▼                                                   ▼
┌──────────────────── apps/server — one Node process ────────────────────┐
│ grammY bot   relay · commands · admin · payments                        │
│ Hono HTTP    /api/* (initData auth) · /tg/webhook · static Mini App     │
│ scheduler    matching · expiry · age transition · outbox · stats · purge│
│              (each job holds a Postgres advisory lock; heavy scoring    │
│               runs in a worker_thread so the bot and API stay fast)     │
│ services → domain (pure) → db repositories (Drizzle)                    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
                     PostgreSQL (constraints + safety triggers)
```

The product owner fixed the stack only partly. These choices are this plan's (each can be revisited by editing this table):

| Area | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces: `apps/server`, `apps/miniapp`, `packages/shared`, `content/` | One install, shared types, no build orchestrator needed |
| Runtime | Node 24 LTS, ESM (`.nvmrc`, CI) | Current LTS |
| Language | TypeScript 6.0 (Phase 0) | TypeScript 7 exists, but typescript-eslint 8.x supports only `<6.1`; revisit when it does |
| Package manager | pnpm 12 with its default minimum-release-age policy; only `esbuild` may run install scripts (`allowBuilds`) | Supply-chain hygiene: brand-new releases are pinned back, not excluded |
| Lint / format | ESLint 10 (typescript-eslint type-checked, `@vitest/eslint-plugin`, `eslint-plugin-react-hooks`) + Prettier. No-literal-string for JSX via core `no-restricted-syntax` | `eslint-plugin-react` doesn't support ESLint 10 |
| HTTP | Hono + `@hono/node-server` | Tiny and TS-first. grammY has a Hono webhook adapter, and Hono's typed RPC client adds almost nothing to the bundle |
| ORM | Drizzle + drizzle-kit migrations | Typed and close to SQL, no engine binary, easy raw SQL for triggers and matching queries |
| DB | PostgreSQL 17+ | Spec |
| Validation | zod schemas in `packages/shared`, used by both apps; `zod/mini` for anything the Mini App bundles | One source of truth at boundaries, small bundle |
| Server build | esbuild bundle (`apps/server/build.mjs`): workspace packages inlined, third-party deps external, migrations copied to `dist/` | Workspace packages ship TS source |
| Tests | Vitest (unit, integration, component), Testing Library, fast-check | One runner. Property tests suit isolation invariants |
| i18n | Small in-house `t()` on top of `Intl.PluralRules`, one set of JSON catalogs for bot and Mini App, key types inferred from `ru.json` | Keeps the bundle small, handles Russian plurals, gives type-safe keys with no codegen |
| Jobs / queue | In-process scheduler, `pg_try_advisory_lock` per job, `outbox` table read with `FOR UPDATE SKIP LOCKED` | No Redis. Durable and idempotent, and still safe if a second instance is ever added |
| Bot transport | Long polling in dev. Webhook with `secret_token` in prod. grammY `auto-retry` + throttler | Telegram rate limits |
| Mini App hosting | The same Node process serves the built static files (hashed, immutable caching) | One deployable |
| Logging | pino JSON with a redaction list | Keeps PII out of logs |
| CI | GitHub + GitHub Actions with a Postgres service container (decided, Q29) | |
| Deploy | One Docker image plus managed Postgres | Matches the one-process constraint |

## 3. How pool isolation is enforced

Pool isolation is enforced in six layers, so a bug in one layer can't break it:

1. **Schema:**
   - `matches` stores `band`, `locale`, `mode`.
   - CHECK `mode = 'friends' OR band = 'adult'`.
   - CHECK `username IS NULL OR age_band = 'adult'` on `users`.
   - CHECK `user_a_id < user_b_id`, and UNIQUE `(user_a_id, user_b_id)`.
2. **Write triggers that re-derive bands from `birth_date` at write time** (never from the cached `age_band`):
   - `matches` INSERT requires:
     - both users `active`;
     - the same live band as `matches.band` and the same locale;
     - for `u18`: mode `friends` and birth dates at most 2 calendar years apart (Q14, decided);
     - no block in either direction.
   - `messages` INSERT requires an open match, a sender who is a participant, both live bands equal to `matches.band`, and neither user frozen.
   - `game_predictions` INSERT requires an open match and a predictor who is a participant.
   - `reveal_consents` INSERT requires `matches.band = 'adult'` and both users adult right now.
3. **State-change triggers:**
   - When a user's `birth_date` or `age_band` changes, or their `status` becomes `frozen`, the same transaction closes all their open matches, cancels their pending outbox rows, clears `active_match_id`, and nulls `username` if the band became `u18`.
   - `birth_date` is write-once except through `admin_set_birth_date()`.
4. **Repository API:**
   - Every read of another user's data goes through `getMatchForParticipant(userId, matchId)`. It checks participation, that the match is readable (not closed for `band_change`), and that live bands are equal.
   - Candidate queries for matching always take a `PoolKey`.
5. **Checks at send time:** the outbox sender and the relay re-check everything right before each Telegram call.
6. **Database roles:**
   - The app connects as `samesync_app`: not the owner, cannot `ALTER`, `DISABLE TRIGGER` or `SET session_replication_role`.
   - `admin_actions` is INSERT-only for that role.
   - Migrations run as the owner role.

Tests in `apps/server/test/safety/` attack each layer on its own. The DB tests run raw SQL as `samesync_app` to prove that layers 1–3 hold even when app code is skipped.

## 4. Data model

Conventions:
- uuid v7 primary keys, `timestamptz` timestamps.
- Enums are Postgres enums.
- Content IDs are stable text slugs (`q.pineapple_pizza`, `i.music.molchat_doma`).
- Content text is **not** stored in the DB. It lives in `content/` files, and the server loads it.

### Users & profile

| Table | Key fields | Notes |
|---|---|---|
| `users` | `id`, `telegram_id` (unique), `public_id` (unique short support code), `locale`, `birth_date` (nullable until set), `age_band` (cache), `status` (`onboarding` / `active` / `waitlisted` / `ineligible` / `frozen` / `deleted`), `mode`, `gender`, `seeking[]`, `username` (adults only), `timezone`, `bot_reachable`, `active_match_id`, `onboarded_at`, `last_active_at`, `frozen_at`, `created_at` | Write-once trigger on `birth_date`. CHECKs: mode vs band, dating fields null unless `mode = 'dating'`, username vs band. Index on `(age_band, locale, mode, status)`. |
| `answers` | PK `(user_id, question_id)`, `value` (`agree` / `disagree` / `skip`), `content_release`, `answered_at` | Index on `(question_id, value)` for rarity stats. |
| `user_interests` | PK `(user_id, item_id)`, `added_at` | Index on `(item_id)`. |

### Content (seeded from `content/`)

| Table | Key fields | Notes |
|---|---|---|
| `content_releases` | `version`, `checksum`, `applied_at` | One row per seeded release. |
| `questions` | `id`, `audiences band[]`, `modes mode[]`, `locales locale[]`, `prior_agree`, `added_in`, `retired_in` | Texts, stances and openers stay in JSON. |
| `interest_categories` | `id`, `domain` (`music` / `games` / `shows` / `memes` / …), `locales[]`, `audiences[]`, `retired_in` | |
| `interest_items` | `id`, `category_id`, `popularity_prior` (`mainstream` / `known` / `niche`), `locales[]`, `audiences[]`, `retired_in` | |

### Matching

| Table | Key fields | Notes |
|---|---|---|
| `feature_stats` | PK `(band, locale, feature_key)`, `n_users`, `pool_size`, `weight`, `computed_at` | Aggregates per pool, never across bands. |
| `match_runs` | `id`, `band`, `locale`, `mode`, `started_at`, `finished_at`, `eligible_users`, `pairs_created`, `tier_counts` | Audit and tuning. |
| `matches` | `id`, `band`, `locale`, `mode`, `user_a_id`, `user_b_id`, `run_id`, `tier`, `score`, `teaser` (content IDs only), `alias_a`, `alias_b`, `status`, `close_reason` (`expired` / `blocked` / `reported` / `frozen` / `band_change` / `left` / `admin` / `deleted`), `created_at`, `game_deadline_at`, `results_ready_at`, `chat_deadline_at`, `first_message_at`, `closed_at` | Insert trigger described in §3. Partial indexes on open matches per user. |
| `blocks` | PK `(blocker_id, blocked_id)`, `match_id`, `created_at` | Checked in both directions by the match trigger. Created in Phase 2, used from Phase 5. |

### Game

| Table | Key fields | Notes |
|---|---|---|
| `games` | `match_id` (PK, FK), `question_ids text[]` (ordered, last = closing split), `closing_question_id`, `a_done_at`, `b_done_at`, `created_at` | Created in the same transaction as the match. |
| `game_predictions` | PK `(match_id, predictor_id, question_id)`, `predicted` (`agree` / `disagree`), `created_at` | Write-once. Participant trigger. |

### Chat

| Table | Key fields | Notes |
|---|---|---|
| `messages` | `id`, `match_id`, `sender_id`, `body`, `verdict` (`delivered` / `blocked_by_filter` / `rejected`), `reason`, `sender_tg_message_id`, `recipient_tg_message_id`, `created_at`, `purge_after` | Insert trigger described in §3. `recipient_tg_message_id` makes reply-to routing work. Retention per Q20. |
| `reveal_consents` | PK `(match_id, user_id)`, `consented_at`, `revealed_at` | Adult-only trigger. |

### Safety & admin

| Table | Key fields | Notes |
|---|---|---|
| `reports` | `id`, `reporter_id` (null for system reports), `reported_id`, `match_id`, `reason` (`spam` / `harassment` / `sexual` / `age_misrepresentation` / `contact_sharing` / `other`), `note`, `evidence jsonb` (snapshot of the last 20 messages), `status` (`open` / `dismissed` / `actioned`), `resolved_by`, `resolved_at`, `created_at` | UNIQUE `(reporter_id, reported_id, match_id)`, so a reporter counts once per match. |
| `filter_events` | `id`, `user_id`, `match_id`, `kind` (`url` / `handle` / `phone` / `email` / `social` / `non_text`), `created_at` | Counters for escalation. |
| `admin_actions` | `id`, `admin_telegram_id`, `action`, `target_user_id`, `before jsonb`, `after jsonb`, `reason`, `created_at` | Append-only (role privileges). Created in Phase 1. |

### Infrastructure & payments

| Table | Key fields | Notes |
|---|---|---|
| `outbox` | `id`, `user_id`, `kind`, `match_id`, `payload jsonb` (i18n key + params, never rendered text), `dedupe_key` (unique), `status` (`pending` / `sent` / `failed` / `cancelled`), `attempts`, `next_attempt_at`, `sent_at`, `last_error` | Rendered in the recipient's locale at send time. |
| `payments` | `id`, `user_id`, `product_id`, `stars_amount`, `invoice_payload` (unique, opaque), `telegram_payment_charge_id` (unique), `status` (`pending` / `paid` / `refunded` / `expired`), `created_at`, `paid_at`, `refunded_at` | Idempotency keys are the two unique columns. |
| `entitlements` | `id`, `user_id`, `kind`, `amount`, `valid_from`, `valid_until`, `source_payment_id`, `revoked_at` | Paid features are still undecided, so this table is generic. |

Products (`content/products.json`) and free-tier limits (config) are versioned files, not tables. Quota usage is computed from `matches` and `entitlements`, so there are no counter tables.

## 5. Matching scoring, in plain words

**The idea.** Two people who both love a band almost nobody has heard of have more to talk about than two people who both "like music". So every shared thing is weighted by how rare it is in their pool, much like a search engine ranks a rare word above "the".

**How rarity is computed** (per pool = band × locale, refreshed before each matching run):
- `N` is the number of active, onboarded users in the pool, and `n_f` is how many of them have feature `f`. A feature is an interest item, or a take answer: agreeing and disagreeing with a take are two separate features.
- Small pools give noisy counts, so the observed share is blended with a prior. Each catalog item carries a curator-set `popularity_prior` (mainstream ≈ 0.30, known ≈ 0.08, niche ≈ 0.01). A take's prior is its expected agree share (default 0.5). With `α` ≈ 50 pseudo-users:
  `share_f = (n_f + α · prior_f) / (N + α)`
- The rarity weight is `w_f = −ln(share_f)`. A feature shared by 1% of the pool weighs ≈ 4.6, one shared by 50% ≈ 0.7, and one shared by 90% ≈ 0.1.
- The statistics use only the pool's own users. They never cross bands.

**Scoring a pair:**
1. Add up the weights of the interest items both picked.
2. Add the weights of the takes where both chose the same side, times a factor `β` (provisional 0.5, since interests are the "specific" signal). Skips count for nothing.
3. In fallback tiers, also add partial credit: both like the same category but different items (tier 2, × `λ_cat` ≈ 0.3), or the same broad domain (tier 3, × `λ_dom` ≈ 0.1). This counts only when they don't already share an item in that category or domain.
4. Divide by the geometric mean of the two users' own profile weight, √(mass_A · mass_B). Without this, someone who ticks every box would beat everyone. It makes the score behave like a cosine similarity.
5. Multiply by a waiting bonus `(1 + γ · wait)`, where `wait` grows with hours since the user's last match and is capped. People who have waited longer get served first.

**Fallback ladder.** Every user starts at tier 1.

| Tier | Counts toward score | Eligibility |
|---|---|---|
| 1 Niche | Items + takes | At least one shared item with weight ≥ `ln 20` (shared by ≤ 5% of the pool) |
| 2 Related | Adds categories | User unmatched ≥ T2 (provisional 24h) |
| 3 Broad | Adds domains, takes-only pairs allowed | User unmatched ≥ T3 (provisional 72h) |

A pair can form at tier *t* only if both users have relaxed to at least *t*.

**Hard filters.** These never relax, at any tier:
- same band, locale and mode;
- `u18`: birth dates at most 2 calendar years apart (Q14);
- dating: each user's gender is in the other's `seeking` (and the age range from Q12);
- not blocked in either direction, never matched before (Q9);
- both active, not frozen, bot reachable, active within 14 days (provisional);
- both under their daily and open-match limits;
- at least 5 commonly answered takes, at least one of them a disagreement (the game needs a split to end on).

**Assignment.** For each pool × mode, score the eligible pairs and sort them by score. Then go down the list greedily, accepting a pair only if neither user has already been given a match in this run. With a fixed seed the result is deterministic, so tests are reproducible.

**Teaser.**
- The teaser names the highest-weight shared item (or category, at tier 2) and the highest-weight shared take, e.g. «Кто-то тоже считает, что ананасы на пицце — норм, и слушает Molchat Doma. Сыграем?»
- Only content IDs are stored, in `matches.teaser`. The text is rendered in the recipient's locale.
- Each domain has its own verb template ("listens to", "plays", "watches"…).

**Scale.** The MVP scores every pair within a pool × mode inside a worker thread. That is fine up to a few thousand users per pool. Past that point (a measured threshold), a later optimization finds candidates first through an inverted index on rare features in SQL, then scores only those. That optimization is not in the MVP.

---

## 6. Phases

### Phase 0 — Scaffold

**Goal.** An empty but production-shaped repo: the bot answers, the Mini App opens and is authenticated through validated initData, the database migrates, i18n works, and CI enforces lint, typecheck and tests.

**Scope**
- `git init`, pnpm workspace, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), and an ESLint flat config: typescript-eslint, no-`any`, no `.only`/`.skip`, and a no-literal-string rule for JSX in the Mini App. Also Prettier, `.editorconfig`, `.nvmrc`, `.env.example`.
- `docker-compose.yml` with Postgres 17.
- `apps/server`:
  - zod config;
  - pino logger with a redaction list;
  - Hono app with `/healthz` and `GET /api/me`;
  - initData auth middleware: HMAC per Telegram's spec, `auth_date` max age (config, provisional 24h), clock-skew tolerance, typed user;
  - grammY bot with `/start` (localized greeting and a `web_app` button) and `/help`;
  - one composition root that starts bot, HTTP and scheduler together, with graceful shutdown.
- Database:
  - Drizzle setup and `samesync_app` role grants;
  - the first migration: a minimal `users` table (`id`, `telegram_id`, `public_id`, `locale`, `status`, `last_active_at`, `created_at`), upserted on the first authenticated request;
  - `pnpm db:migrate`;
  - a test harness: migrate a template database once per run, then give each test file a fresh copy (`CREATE DATABASE … TEMPLATE`).
- i18n:
  - shared runtime, `ru.json` / `en.json`, locale resolution from `language_code` (`ru*` → ru, everything else → en, Q13);
  - the Mini App loads only the active locale (dynamic import).
- Content:
  - zod schemas for questions, interests, openers, aliases and products;
  - a few sample entries;
  - `pnpm content:check`: zod schema validation, unique IDs, every locale present, valid references. (The `content.lock.json` text-hash and revision-bump check moved to Phase 1, where seeding happens.)
- `apps/miniapp`:
  - Vite + React + TS;
  - SDK init inside `src/platform/` using `@tma.js/sdk-react` (Q32, decided); verify the current version and bundle cost;
  - Telegram theme params mapped to CSS variables;
  - typed API client that sends `Authorization: tma <initData>`;
  - a screen with a localized greeting from `/api/me`;
  - browser dev mode using the SDK's environment mock plus `pnpm dev:initdata`, which signs initData with the **dev** bot token. The server has no bypass.
- CI (GitHub Actions): frozen install, lint, typecheck, `test` (Postgres service), `content:check`, build. (The size-limit bundle budget step moved to Phase 6.)
- `apps/server/test/safety/` exists with its first suite (auth) and its own CI step.
- Manual one-time setup: create a **dev** bot in @BotFather, set its Mini App URL and menu button, and set up a local HTTPS tunnel. (Staging bot creation moved to Phase 6.)

**Out of scope.** Any product feature, birth date, content seeding into the DB, deployment, payments.

**Acceptance criteria**
- [x] On a fresh clone, the CLAUDE.md commands bring up the database, server and Mini App.
- [x] In Telegram, `/start` on the dev bot replies in ru for a ru client (en otherwise) with a button that opens the Mini App. *(ru verified in Telegram; en verified by `apps/server/test/bot/start.test.ts` only, see the locale observation in the notes below.)*
- [x] The Mini App shows the user's first name, taken from `/api/me` after server-side validation.
- [x] A request with no initData, forged initData, initData for another bot, or expired initData gets 401.
- [x] A `user_id` in the body or query is ignored.
- [x] Migrations apply to an empty database, and re-running them does nothing.
- [x] CI is green on main: lint, typecheck, tests, safety suite, content check, build.

**Tests that prove it**
- `packages/shared/src/i18n/i18n.test.ts`: ru and en have identical keys and identical placeholders per key; every key has every plural category for its locale (ru: one/few/many/other; en: one/other); interpolation and plural selection work (1, 2, 5, 21 in ru).
- `apps/server/test/safety/auth.test.ts`: accepts valid initData; rejects a tampered field, a wrong bot token, a missing hash, an expired or future `auth_date`, malformed `user` JSON, and duplicate parameters; ignores identity from body or query.
- `apps/server/test/http/me.test.ts`: 401 without a header; 200 with the validated user; upsert is idempotent.
- `apps/server/test/bot/start.test.ts`: uses a grammY harness that feeds updates through `bot.handleUpdate` and captures outgoing API calls via a transformer. `/start` sends a localized text and a `web_app` button.
- `apps/server/test/config.test.ts`: the process refuses to start with missing or invalid env and names the variable.
- `apps/server/test/db/migrations.test.ts`: migrating from empty succeeds, re-running is a no-op, and `samesync_app` cannot `ALTER TABLE`.
- `content/test/check.test.ts`: sample content passes; fixtures that fail schema validation, have a missing locale, a duplicate ID, or a dangling reference fail.
- `apps/miniapp/src/screens/Hello.test.tsx`: renders the greeting through a mocked platform adapter and API.

**Phase 0 implementation notes (2026-10-03).** Deviations from, and additions to, the scope above:
- **Toolchain pins:**
  - TypeScript 6.0, ESLint 10 without `eslint-plugin-react`, and pnpm 12 (see §2).
  - `eslint` is pinned to `~10.11` and `pino` to `~10.3.1` because 10.12.0 and 10.4.0 were published inside pnpm's minimum-release-age window. Bump them once they age.
  - **Local development must use Node 24 (per `.nvmrc`), matching CI.** Phase 0 itself was verified locally on Node 26.8.1 and in CI on Node 24; from now on run everything locally on Node 24 so local and CI results are comparable.
- **App role bootstrap:**
  - Migration `0001_app_role` creates `samesync_app` NOLOGIN (no passwords in migrations) and grants SELECT/INSERT/UPDATE on `users` (no DELETE).
  - The login is set by `infra/postgres/init/01-app-role.sh` locally and by the hosting provider in production (Phase 6).
  - Tests run app code as `samesync_app` through the `-c role=samesync_app` startup option, so no test query runs with owner rights by accident.
- **`users.status`** already uses the full status enum from §4. Only `onboarding` is used in Phase 0.
- **Added fail-safe:** the server refuses to start with `U18_POOL_ENABLED=true` when `NODE_ENV=production` (CLAUDE.md invariant 12, gate G3). Removing that check is a deliberate code change once G3 is signed off.
- **Added early:** `apps/server/test/logging/redaction.test.ts` (listed under Phase 6) and a scheduler unit test.
  - The scheduler is a stub with no jobs. Advisory locks come with the first real job (Phase 2).
- **initData `signature`:**
  - Real Telegram initData always contains `signature` (Ed25519, for third-party validation), and the SDK refuses initData without it.
  - The server validates only the HMAC `hash`, which covers `signature`.
  - `pnpm dev:initdata` adds a random placeholder signature, covered by a regression test.
- **Bot:** ignores everything outside private chats. A missing `language_code` falls back to en (Q13 rule).
- **Not in Phase 0, as planned:** webhook mode and serving the built Mini App from the server (Phase 6, deployment).
- **Dev tooling:** `.claude/launch.json` defines the Vite dev server for Claude Code's preview pane.
- **Found during the browser check, then fixed:**
  - a JSON import attribute broke locale loading in the Vite dev server;
  - dev initData lacked `signature`.
- **Locale observation on the real dev bot (2026-10-03), not resolved:**
  - The product owner switched Telegram's own app language to English and fully restarted Telegram. `/start` still got a Russian reply, and the Mini App stayed Russian.
  - In Phase 0 the bot uses the `language_code` of each update and the Mini App the one in its initData; neither reads the stored `users.locale` (`ru` for this user). So Telegram most likely kept sending `ru`. A code review re-ran the real code and found no path from `en` to Russian.
  - The actual values were not captured: the product owner skipped the capture.
  - Automated coverage: the bot's en path is in `apps/server/test/bot/start.test.ts`, and English rendering in `apps/miniapp/src/screens/Hello.test.tsx`. Resolving the Mini App's locale from initData isn't unit-tested; the code review exercised it with real initData.
  - **For Phase 1:** don't rely on `language_code` to switch languages. The language screen must let users choose explicitly, and that choice (`users.locale`, Q13) drives the bot and the Mini App. Re-test the English path in Telegram once that lands.

---

### Phase 1 — Onboarding

**Goal.** A new user can go from `/start` to a complete swipe profile in about 3 minutes, with a write-once birth date and the right band, locale and mode.

**Scope**
- Schema:
  - `users` gains `birth_date`, `age_band`, `mode`, `gender`, `seeking`, `username`, `timezone`, `onboarded_at`, `bot_reachable`;
  - new tables `answers`, `user_interests`, the content tables, and `admin_actions`.
- SQL:
  - `vc_age_years(birth_date, on_date)`;
  - the write-once trigger on `birth_date`;
  - `admin_set_birth_date(user_id, new_date, admin_tg_id, reason)`: a SECURITY DEFINER function that requires a reason, writes `admin_actions`, and recomputes `age_band`. Phase 1 has no bot command for it; Phase 5 adds one.
  - the band/mode/username CHECKs.
- `packages/shared`: `ageOn(birthDate, onDate)` and `bandFor(age)`: UTC date, and Feb 29 birthdays fall on Mar 1 in non-leap years (Q15, decided), which matches Postgres `age()`.
- Content lockfile (moved from Phase 0): `content.lock.json` stores a hash of every localized text per content ID; `pnpm content:check` fails if a text changes without a `revision` bump.
- Content seeding: `pnpm content:seed` is an idempotent upsert that records a release and handles retirement. Initial content must at least let the band × mode decks each draw 35 takes in both locales, plus ≥ 150 interest items across ≥ 4 domains. Real launch content is a content task (Q6).
- API:
  - `POST /api/onboarding/birth-date`: once only, returns the band or `ineligible`;
  - `POST /api/onboarding/locale`;
  - `POST /api/onboarding/mode`: `u18` gets friends only; dating requires `gender` (one option ID) and `seeking` (one or more option IDs) from the content option list (Q11);
  - `GET /api/deck`: takes filtered by band, mode and locale;
  - `PUT /api/profile/answers`;
  - `GET /api/interests?domain=&q=`;
  - `PUT /api/profile/interests`;
  - `POST /api/onboarding/complete`: checks the minimums (≥ 25 non-skip answers, 5–30 interests; Q5/Q6, decided).
- Mini App screens:
  - language (preselected from `language_code`);
  - birth date: shows the computed age with a confirmation ("You're 16 — right? This can't be changed later");
  - ineligible screen for under-14s;
  - mode picker (adults only; `u18` skips it);
  - dating details: "You are" (man / woman) and "Looking for" (men / women, multi-select), labels from content (Q11);
  - swipe deck: agree / disagree / skip, progress, undo last;
  - interest picker: domain tabs, search, chips, min/max counter;
  - done screen. If `allows_write_to_pm` is false, it calls `requestWriteAccess()` so the bot can send notifications.
- Profile editing (answers and interests) from a settings screen. Changes affect future matches only (Q5). The birth date is shown read-only, with the support code and a hint to contact support.
- Mode switching (Q10, decided): adults can switch between friends and dating in settings, one mode at a time. Switching to friends clears `gender` and `seeking` (the §4 CHECK requires it); switching to dating asks for them. Open matches stay open. `u18` users have no switch.
- Under-14: store `birth_date` and set status `ineligible`, with no other profile data. The user can't retry with a different date (Q16).
- Turning 14 (Q16, decided): when an `ineligible` user opens the Mini App and `ageOn(birth_date, today)` is ≥ 14, their status moves to `onboarding` and they continue. The birth date is still not editable.
- `U18_POOL_ENABLED=false` → `u18` users finish onboarding as `waitlisted`.
- Locale (Q13, decided): the language screen preselects from `language_code` and stores the choice in `users.locale`. From Phase 1 on, bot replies and the Mini App UI use the stored `users.locale`; Phase 0 followed the live `language_code` of each update and launch. A settings screen lets the user change it.
- Content format: authors follow `docs/content-format.md`. Its "Schema changes needed in Phase 1" list is part of this phase's scope, and the doc is updated in the same change as the schemas.
- Usernames are captured from initData and updates **for adults only**.
- The Mini App reports the device's IANA timezone (`Intl`), stored in `users.timezone` and used for quiet hours (Q22).

**Out of scope.** Matching. Any way for a user to edit their birth date (never planned). The admin bot command (Phase 5). Photos, bios, avatars (Q7).

**Acceptance criteria**
- [x] A manual run in Telegram completes onboarding in ≤ 3 minutes in both locales. *(Passed 2026-10-03, product owner, dev bot. The ru dating-mode run took about 2 minutes. Settings showed the birth date read-only with the support code. Switching the language to English changed the UI at once, and `/start` then replied in English. The en friends-mode run showed no dating-only takes.)*
- [x] Birth date: a second submission gets 409; a direct `UPDATE` as `samesync_app` raises; `admin_set_birth_date()` succeeds only with a reason and writes an audit row. *(test/safety/birth-date-immutable.test.ts)*
- [x] `ageOn()` and `vc_age_years()` agree on all tested dates. *(test/safety/age-sql-parity.test.ts: 1,500 random pairs plus birthday, Feb 29 and fixed edge cases)*
- [x] A `u18` user can't be put in dating mode or have a username stored, through either the API or SQL. *(test/safety/band-constraints.test.ts, username-capture.test.ts)*
- [x] An under-14 user sees the ineligible screen, and nothing but `telegram_id`, `birth_date` and `status` is stored for them. *(Plus the Phase 0 account basics; see the implementation notes. test/onboarding/flow.test.ts, apps/miniapp/src/App.test.tsx)*
- [x] A `u18` deck never contains adult-only takes. Interest items respect locale and audience. *(test/onboarding/flow.test.ts)*
- [x] Every new screen and bot message exists in ru and en. Russian copy is gender-neutral. *(Key, placeholder and plural parity in packages/shared/src/i18n/i18n.test.ts; gender-neutrality by review)*

**Tests that prove it**
- `packages/shared/src/age.test.ts`: the day before, of and after the 14th and 18th birthdays; Feb 29 births in leap and non-leap years; future and implausible dates rejected.
- `apps/server/test/safety/age-sql-parity.test.ts`: a fast-check property test showing `ageOn` equals `vc_age_years` on ≥ 1,000 random (birth, on) pairs, including edge dates.
- `apps/server/test/safety/birth-date-immutable.test.ts`: the API returns 409, SQL updates as the app role are rejected, the admin function works and writes an audit row, and the function fails without a reason.
- `apps/server/test/safety/band-constraints.test.ts`: `u18` + dating is rejected; `u18` + username is rejected; a change to `u18` through the admin function nulls the username.
- `apps/server/test/onboarding/flow.test.ts`: steps can't run out of order; the minimums are enforced; unknown or retired question IDs and items for the wrong locale or audience are rejected; re-submission is idempotent; `waitlisted` applies while the flag is off; an `ineligible` user can continue from their 14th birthday but still can't change the birth date (Q16); an adult can switch mode, and switching to friends clears gender and seeking without closing open matches (Q10); `u18` can't switch to dating.
- `apps/server/test/content/seed.test.ts`: seeding is idempotent; retiring a question keeps existing answers; the lockfile catches silent text changes.
- `content/test/check.test.ts` (extended): a fixture with changed text and no `revision` bump fails; the same change with a bump passes and updates the lockfile.
- `apps/miniapp`: birth date form validation and confirmation; deck agree/disagree/skip/undo; no mode picker for `u18`; the write-access request runs when needed.

**Phase 1 implementation notes (2026-10-03).** Deviations from, and additions to, the scope above:
- **Content (docs/content-format.md is the reference):**
  - The launch content (`questions/core.json`, `questions/dating.json`, `interests/catalog.json`) is committed exactly as authored. Authored content and the generated lockfile are excluded from Prettier; `content:check` validates them.
  - Every §8 schema change is implemented. `release.json` is **required** (every content root declares its version), so the content tests build their fixtures programmatically instead of using static folders.
  - The item-ID domain check (§8 called it optional) is enforced; the launch content passes it.
  - Hidden files such as `.DS_Store` are ignored by the folder allowlist.
  - `pnpm content:lock` rewrites the lockfile and refuses to hide a text change without a revision bump, a lowered revision, or a removed ID. The lockfile hashes texts only, not `priorAgree`, `popularity` or `audiences`.
  - `content:check --launch` counts items **per locale** (ru 187, en 157). Counted per band × locale, `u18:en` would have only 127 items (< 150); see Q6.
- **Seeding and startup:**
  - `pnpm content:seed` (owner role) refuses to reuse a seeded release version for changed content, to seed an older release, or to drop a seeded ID.
  - The server refuses to start unless the seeded release and checksum match the files. Workflow after a content change: bump `release.json`, then `pnpm content:lock` and `pnpm content:seed`.
  - Test databases are cloned from a template that is migrated **and** seeded with the real content.
- **Schema:**
  - `users.locale_confirmed_at` (not in §4) records the language step.
  - `admin_actions.id` uses `gen_random_uuid()` because the rows are written by `admin_set_birth_date()`.
  - The band, mode and username CHECKs use `coalesce(…, false)`. Without it, a NULL `age_band` satisfied `= 'adult'`; the safety suite caught this before anything shipped.
  - `vc_age_years()` returns NULL for a date before the birth date, and `ageOn()` throws there (found by the parity property test).
  - `admin_set_birth_date()` is executable by the owner only. Phase 5 must grant it to `samesync_app` deliberately, together with the admin allowlist check.
- **Under-14 (Q16):** besides `telegram_id`, `birth_date` and `status`, the account basics from Phase 0 also exist (`id`, `public_id`, `locale`, `locale_confirmed_at`, timestamps, `bot_reachable`). No profile data, answers or interests are stored (CHECK plus tests).
- **API (additions to the scope list):**
  - `GET /api/dating-options` serves the localized labels.
  - `PUT /api/profile/locale` and `PUT /api/profile/mode` serve settings next to the onboarding routes.
  - Progress counts non-skip answers among the takes in the user's current deck scope.
  - During onboarding, interests can only be saved once the deck minimum is met.
  - The deck draw is deterministic per user ID, so the same deck comes back on every open.
- **Locale (Q13):** bot replies, API responses and the Mini App all use the stored `users.locale`. Telegram's `language_code` only preselects the language before a user row exists. `/start` alone creates no user row.
- **Usernames:** refreshed from initData and bot updates for live adults only (age checked in SQL), and cleared when an adult removes theirs. Never stored for `u18` users or users without a birth date.
- **Mini App:**
  - The deck brings skipped cards back until 25 are answered, and stops as soon as the minimum is reached.
  - The done screen asks for write access automatically when `allows_write_to_pm` is false, with a button as fallback.
  - The domain tab labels mirror the content `DOMAINS` list.
  - Initial JS is 93.9 KB gzip (budget 150 KB).
- **Not testable yet:** "open matches stay open" when the mode changes (Q10). No matches exist before Phase 2; the flow test checks that answers and interests are kept. **Phase 2 must add the open-match assertion.**
- **Found and fixed during Phase 1:**
  - A root `.env` with `NODE_ENV=development` made `vite build` produce a development build (React dev runtime and the dev Telegram mock, 156.5 KB gzip). This was a Phase 0 bug in `vite.config.ts`, now covered by a regression test.
  - The JSX i18n lint rule also flagged keys passed to `t()` in attributes; it now flags only direct attribute text.
- **Local setup after pulling Phase 1:** run `pnpm db:migrate` and `pnpm content:seed` before `pnpm dev`. Existing users start at the language step.

---

### Phase 2 — Matching engine

**Goal.** Scheduled runs create good matches inside each isolated pool, ranking rare overlaps higher and falling back to broader ones when needed, and the bot notifies both users with a specific teaser.

**Scope**
- Tables: `feature_stats`, `match_runs`, `matches`, `blocks`, `outbox`, `games` (shell only; Phase 3 fills the rest).
- Safety SQL:
  - the `matches` insert trigger (§3);
  - the state-change trigger (band change or freeze closes open matches and cancels the outbox);
  - the age-transition job (hourly). It reconciles the `age_band` cache from `birth_date`, which fires the closing trigger. A user who has just turned 18 lands in the adult pool in `friends` mode and can opt into dating.
- `domain/matching/`, all pure: rarity, scoring, tiers, eligibility, greedy assignment, teaser selection, alias generation (from the localized `content/aliases`).
- Matching run:
  - scheduled per pool × mode (Q8; provisional twice a day per pool, configurable);
  - holds an advisory lock;
  - recomputes stats, then scores in a worker thread;
  - inserts matches and outbox rows in one transaction per pair;
  - logs `match_runs`.
- Limits: provisional free tier of 3 new matches/day and 5 open matches (config; Q27). They are applied as eligibility filters.
- Outbox sender:
  - stays under Telegram's bulk limit (~30 msg/s overall, 1 msg/s per chat);
  - exponential backoff;
  - `dedupe_key` prevents doubles;
  - a 403 ("bot blocked by user") sets `bot_reachable = false`;
  - **re-checks match state, both live bands and freeze status before every send**;
  - renders in the recipient's locale;
  - holds non-urgent notifications during the recipient's local quiet hours (Q22).
- Notification: the teaser text plus a `web_app` button that deep-links to the match in the Mini App. The Mini App home lists the user's matches; the match screen is a placeholder until Phase 3.
- Dev tooling: `pnpm dev:population --pool adult:ru --mode friends --n 500` builds a synthetic population. It refuses to run when `NODE_ENV=production`.

**Out of scope.** Game logic, chat, report/block UI (the `blocks` table only feeds exclusion), paid boosts, ML or embeddings, the candidate index for large pools.

**Acceptance criteria**
- [ ] Every created match passes all hard filters. This is shown by property tests over random populations and by direct SQL attacks.
- [ ] Ranking: a shared niche item beats a shared mainstream one; a shared minority take beats a shared majority take; a "picked everything" profile doesn't dominate.
- [ ] Fallback: a user with no tier-1 partner gets a tier-2 or tier-3 match once the waiting threshold passes, if one exists. Fallback never crosses band, locale, ±2y or dating compatibility.
- [ ] Turning 18: when the age-transition job runs, the user's open matches with `u18` users close and cancelled notifications are never sent. Before the job runs, the outbox and the match trigger already refuse cross-band actions based on the live band.
- [ ] Each user in a match gets exactly one notification in their locale naming a real shared item or take. A crash or rerun creates no duplicates.
- [ ] Benchmark: a run on 5,000 synthetic users in one pool finishes in < 60 s, and the main event loop never lags more than 100 ms (manual or nightly benchmark, not a CI gate).

**Tests that prove it**
- `apps/server/src/domain/matching/rarity.test.ts`: the smoothing formula, the effect of the prior for small N, and the ordering niche > known > mainstream.
- `…/score.test.ts`: the ranking properties above, normalization, the β/λ factors, the wait bonus, and that skips are ignored.
- `…/tiers.test.ts`: the relaxation thresholds; a pair forms only at the minimum tier of the two users.
- `…/assign.test.ts`: at most one match per user per run; a fixed seed gives deterministic output; quotas are respected.
- `…/teaser.test.ts`: picks the top-weight item and take, has a template for each tier and domain, and renders in ru and en.
- `apps/server/test/safety/pool-isolation.property.test.ts`: fast-check generates random multi-pool populations (bands, locales, modes, birth dates near boundaries, genders, blocks, frozen users). For every output pair it asserts same band, same locale, same mode, `u18` ⇒ friends and ≤ 2y, dating compatibility, not blocked, not frozen, no rematch, and at most one per run, at every tier.
- `apps/server/test/safety/pool-isolation.db.test.ts`: as `samesync_app`, direct `INSERT INTO matches` fails for cross-band, cross-locale, `u18` > 2y, `u18` dating, a blocked pair, a frozen user, `user_a > user_b`, and a duplicate pair. The trigger uses the live band even when the cached `age_band` is deliberately stale.
- `apps/server/test/safety/age-transition.test.ts`: a user whose birth date is set so that they are 18 today (via the admin function) has all `u18` matches closed with `band_change` and their outbox cancelled; counterpart data is unreadable afterwards.
- `apps/server/test/safety/outbox-recheck.test.ts`: the sender drops messages for closed matches, mismatched live bands and frozen users, and records why.
- `apps/server/test/matching/run.integration.test.ts`: two concurrent runs → only one does work (advisory lock); unreachable users are excluded; a rerun is idempotent.
- `apps/server/test/bot/notify.test.ts`: localized teaser and button; a 403 marks the user unreachable.

---

### Phase 3 — Game

**Goal.** Matched users play an async "guess their answer" game whose results show how well they read each other and end on one unresolved disagreement, with a ready-made opener.

**Scope**
- `domain/game/select.ts` runs inside the match transaction and picks the questions. Provisionally 5 (Q3):
  - all answered (not skipped) by both users;
  - the **closing question** is a take they split on; when there are several, pick the one whose pool split is closest to 50/50 (the most debatable);
  - the other picks mix agreements (preferring rare shared takes) with at most one more disagreement;
  - the closing question always comes last.
- Tables: `game_predictions` plus `games.a_done_at` / `b_done_at`. A participant-only insert trigger. Predictions are write-once and submitted as one batch.
- API:
  - `GET /api/matches`;
  - `GET /api/matches/:id`: teaser, aliases, status, deadlines;
  - `GET /api/matches/:id/game`: the questions only, **never the counterpart's answers**;
  - `PUT /api/matches/:id/predictions`;
  - `GET /api/matches/:id/results`: 409 until both users are done.
- Results:
  - "You guessed X/5 of theirs, they guessed Y/5 of yours";
  - the answers for each question side by side;
  - the final card: the closing question with "You split on this one. Ask why.";
  - the opener, which the user can edit. The send action is wired in Phase 4 and disabled until then.
- Openers come from templates, not an LLM (Q4). Each take in `content/` has an opener per side (from the viewer's side) in ru and en, with a generic fallback built from the statement. Russian copy is gender-neutral.
- Notifications through the outbox:
  - "Your match finished — your turn" when the other user finishes first;
  - "Results are ready" to both;
  - one reminder before the game deadline (Q2, decided).
- Expiry job: a `pending_game` match past `game_deadline_at` (created + 48h, Q2, decided) becomes `expired`, and both users get a neutral notification.
- Mini App: match intro (teaser), prediction cards, a waiting screen (refetches on `visibilitychange` or focus; no WebSockets), results.

**Out of scope.** Sending messages (Phase 4), LLM-generated text, score history or leaderboards, rematches.

**Acceptance criteria**
- [ ] Every game has exactly the configured number of questions (provisional 5), all answered by both users, and its last question is a split.
- [ ] Before a user has submitted and both are done, no endpoint returns the counterpart's answers. Predictions can't be changed after submission.
- [ ] Results are computed correctly, and the opener renders in the match's locale, referring only to the closing question.
- [ ] A non-participant gets 404. A match closed with `band_change` gets 404 for both former participants.
- [ ] Both users get the right notifications exactly once. Unplayed matches expire on time.

**Tests that prove it**
- `apps/server/src/domain/game/select.test.ts`: a property test. For random answer pairs that satisfy the eligibility rule (≥ 5 common, ≥ 1 split), the last question is a split, every question was answered by both, the output is deterministic with a seed, and the choice is the most balanced split.
- `…/results.test.ts`: score math and the edge cases (all correct, none correct).
- `…/opener.test.ts`: every take × side × locale renders with no missing placeholders; the fallback is used when an opener is missing; output contains nothing beyond the closing question.
- `apps/server/test/game/api.test.ts`: participants only; no peeking (the game endpoint never carries counterpart answers, and results return 409 before both are done); write-once predictions; deadline expiry.
- `apps/server/test/safety/game-isolation.test.ts`: the DB rejects predictions from non-participants and on closed matches; after a band change, neither side can read the game or results.
- `content/test/check.test.ts` (extended): every take has stance texts (for teasers) and openers or a valid fallback in both locales.
- `apps/miniapp`: prediction flow, the waiting state, and results rendering with the closing card last.

---

### Phase 4 — Anonymous bot-relayed chat

**Goal.** Matched users talk anonymously in the bot's DM. Matches expire after 48h of silence. Adults can reveal usernames to each other after both agree; minors never can.

**Scope**
- Tables: `messages`, `reveal_consents`, plus `users.active_match_id`. Insert triggers per §3.
- Relay pipeline (`services/relay.ts`), shared by bot messages and `POST /api/matches/:id/messages` (sending the opener from the Mini App):
  1. Identify the sender.
  2. Choose the target match: the reply-to mapping first, then `active_match_id`, otherwise ask the sender to pick (Q24).
  3. Validate:
     - sender is a participant;
     - match is open (`results_ready` or `active`);
     - **both live bands are equal**;
     - neither user is frozen and there is no block;
     - plain text only, in both pools for the MVP (Q19);
     - length ≤ 2,000 characters;
     - per-user rate limit (provisional 20/min).
  4. Run the screening hook. In Phase 4 it enforces text-only; Phase 5 plugs in the contact filter.
  5. Store the message.
  6. Send it to the recipient as a **new plain-text message** (no `parse_mode`, no entities, never forward or copy): alias header plus text, with inline buttons.
  7. Store `recipient_tg_message_id` for reply routing.
  8. On the first message, set `status = active` and clear the chat deadline.
- Bot commands:
  - `/chats`: lists open matches with "write here" buttons;
  - `/leave`: closes the match, and the other user gets a neutral "This chat has ended";
  - `/reveal`: adults only.
  - Commands are registered per locale with `setMyCommands(language_code)`.
- Edited messages are not passed on, and the sender is told that edits don't go through. Non-text messages are rejected with a localized notice.
- Expiry job: `results_ready` matches with no message by `chat_deadline_at` (results_ready + 48h, Q2, decided) become `expired`, and both users are notified. After the first message a match no longer expires; one reminder is sent before the chat deadline.
- Mutual reveal (adults only):
  - the first consent sends the other user an "Agree / Not now" prompt;
  - when both agree, the bot reads each user's **current** username via `getChat` and sends each one the other's;
  - a user without a username is asked to set one, and their consent stays pending (Q25).
  - In the `u18` band there is no button, the command answers "not available", and the DB trigger rejects consent rows.
- Retention purge job for message bodies (Q20; provisional 30 days).

**Out of scope.** Media in any pool (Q19), group chats, typing or read indicators, syncing edits and deletions, the contact filter and report/block (Phase 5), live chat inside the Mini App.

**Acceptance criteria**
- [ ] Two test accounts can chat through the bot. The recipient sees only the alias and the text: no "forwarded from", no name, no username, no profile link.
- [ ] With several open matches, messages always reach the intended match (reply-to and the active pointer both work, and an ambiguous message asks).
- [ ] A match with no messages expires exactly once at its deadline. The first message stops expiry.
- [ ] Username reveal works only in adult matches after both consent. In `u18` matches it is impossible through the API, the bot and the DB.
- [ ] If a participant's band changes mid-conversation, the next message is refused and the match closes, even if the age-transition job hasn't run yet.

**Tests that prove it**
- `apps/server/test/chat/relay.test.ts` (grammY harness):
  - only `sendMessage` is called; `forwardMessage` and `copyMessage` never are;
  - there is no `parse_mode` and no entities;
  - the alias header and buttons are present;
  - the message is stored and the status flips on the first message.
- `apps/server/test/chat/routing.test.ts`: reply-to beats the pointer; an ambiguous message triggers the picker; a closed match is refused politely.
- `apps/server/test/chat/expiry.test.ts`: deadlines, idempotency, notifications.
- `apps/server/test/chat/reveal.test.ts`: needs both consents; uses the current username; handles a missing username; a closed match can't reveal.
- `apps/server/test/safety/chat-isolation.test.ts`:
  - the DB rejects messages for closed matches, from non-participants, and with a live band mismatch (with a stale cache);
  - the relay refuses and closes the match after an admin birth-date correction;
  - nothing is relayed to or from a frozen user.
- `apps/server/test/safety/u18-no-username.test.ts`: a leak scanner. It drives a full `u18` conversation, including `/reveal` attempts, through the harness and asserts that neither side's username, first name, last name or `telegram_id` appears in any captured outgoing API call or API response.
- `apps/server/test/safety/u18-text-only.test.ts`: photo, voice, video, sticker, document, contact, location and text with entities are all rejected without delivery; `reveal_consents` insert fails for `u18`.

---

### Phase 5 — Safety & admin tooling

**Goal.** Every chat can be reported and blocked, repeat offenders are frozen automatically, contact sharing in the under-18 pool is filtered, and admins can run moderation from the bot.

**Scope**
- Report:
  - entry points: an inline button under every relayed message, `/report` in the active chat, and a button on the Mini App match screen;
  - reasons include **age misrepresentation** ("seems younger or older than allowed");
  - an evidence snapshot of the last 20 messages in both directions;
  - one counted report per reporter per match;
  - system reports from filter escalation.
- Block: a button or command that inserts `blocks`, closes the match with `blocked`, and permanently excludes the pair in both directions. The other user sees only "This chat has ended".
- Auto-freeze:
  - triggers at N distinct reporters within a window (Q18; provisional 3 in 30 days for adults, 2 for `u18`);
  - sets `status = frozen`, and the trigger closes matches and cancels the outbox;
  - the user gets a localized notice with `/support`;
  - admins are alerted. Age-misrepresentation reports alert admins immediately, whatever the count.
- Under-18 contact/link filter (`domain/safety/contact-filter.ts`, pure). Normalization:
  - NFKC and case-folding;
  - Cyrillic/Latin homoglyph mapping;
  - collapsing separators and spaced-out characters;
  - number words (ru/en);
  - "собака", "at" and "(at)" read as @; "точка" and "dot" read as ".".

  Detectors:
  - URLs and bare domains, including `.рф`;
  - `t.me` / `telegram.me` links;
  - `@handles`;
  - phone numbers (≥ 9 digits after normalization);
  - emails;
  - social keywords plus a handle ("инста", "inst", "тг", "вк", "discord", "snap"…).

  It runs on the message **and** on a sliding window of the sender's last 3 messages in that match, so split-up contacts are caught.

  On a hit: the message is not delivered, the sender gets a localized notice, and a `filter_events` row is written. K hits in 24h (provisional 3) create a system report. A filter exception also means no delivery.
- Admin commands:
  - only for `ADMIN_TELEGRAM_IDS`, only in private chat; anyone else gets the normal unknown-command reply;
  - `/admin` (help), `/reports [open|all]`, `/report_view <id>` (with evidence), `/resolve <id> dismiss|action [note]`;
  - `/user <public_id|telegram_id>` (status, band, report counts; never message content outside a report);
  - `/freeze <user> <reason>`, `/unfreeze <user> [note]`;
  - `/setbirthdate <user> <YYYY-MM-DD> <reason>`, which calls `admin_set_birth_date()`; a resulting band change closes cross-band matches at once;
  - `/stats` (pool sizes and liquidity per pool × mode);
  - destructive commands need an inline-button confirmation;
  - every action writes `admin_actions`.
- `/support`: relays a user's text to admins (as bot-composed text with their `public_id`). Admins answer with `/reply <public_id> <text>`.
- Account deletion (provisional, Q23): `/delete` with confirmation closes matches, anonymizes the profile, and deletes answers and interests. Reports and audit rows are kept as required for safety.
- A readiness checklist for flipping `U18_POOL_ENABLED` (§7).

**Out of scope.** A web admin panel, ML or image moderation, an appeals UI, age verification (Q21), moderating adult-pool content beyond reports.

**Acceptance criteria**
- [ ] Report and block are reachable from every chat surface: each relayed message, chat commands, and the Mini App match screen.
- [ ] N distinct reporters freeze an account automatically; repeated reports from the same reporter count once. A frozen user gets 403 from the API, can't relay, isn't matched, and has pending notifications cancelled.
- [ ] Blocked pairs are never rematched and can't message each other.
- [ ] The filter blocks 100% of the positive corpus (ru and en: obfuscated, homoglyph, and split across messages) and lets 100% of the negative corpus through (times, prices, years, scores, "7 rings", "C++", …). The corpus has ≥ 150 entries per locale.
- [ ] Admins can review reports with evidence, freeze and unfreeze, and correct birth dates (pool moves and cross-band chats close immediately). Every action is audited. Non-admins can't tell that admin commands exist.

**Tests that prove it**
- `apps/server/src/domain/safety/contact-filter.test.ts`: table-driven over `apps/server/test/fixtures/contact-filter/{ru,en}.json` (positives and negatives); a sliding-window test; a normalization unit test. Every bypass found in production is added to the corpus.
- `apps/server/test/safety/filter-fail-closed.test.ts`: an injected filter exception means no delivery and the sender gets a notice.
- `apps/server/test/safety/report-freeze.test.ts`: distinct-reporter counting, the window, the `u18` threshold, side effects of freezing, the admin alert, and immediate alerts for age-misrepresentation reports.
- `apps/server/test/safety/block.test.ts`: closes the match, excludes in both directions in matching and in the DB trigger, notifies the counterpart neutrally.
- `apps/server/test/safety/frozen-user.test.ts`: API 403, relay refused, excluded from matching, outbox cancelled; after unfreeze, matching resumes but no old matches come back.
- `apps/server/test/admin/commands.test.ts`: allowlist, private chat only, silent for non-admins, confirmation flow, an audit row for each command, argument validation.
- `apps/server/test/safety/admin-birthdate-pool-move.test.ts`: correcting adult → `u18` and `u18` → adult closes cross-band matches, nulls the username when the user becomes `u18`, and makes old counterpart data unreadable.
- `apps/server/test/account/delete.test.ts`: anonymization, closures, what is kept and what is removed.

---

### Phase 6 — Stars payment plumbing, free-tier limits, visual pass, deployment

**Goal.** Payments work end-to-end with a placeholder product, free-tier limits are visible and enforced, the UI gets its minimalist polish, and the app runs in staging and production.

**Scope**
- Stars plumbing:
  - Products live in `content/products.json`: `id`, `stars`, `grants` (entitlement kind, amount, duration), `bands_allowed`, `enabled`. Paid features are undecided (Q27), so the only product is a placeholder `test.extra_match`, enabled only outside production.
  - Purchase flow:
    1. `POST /api/payments/invoice` checks the user is active, the product is enabled, and the user's band is allowed. Purchases are off for `u18` per Q26.
    2. It creates a `pending` payment and calls `createInvoiceLink` with currency `XTR`, an empty provider token, a localized title and description, and the opaque payment ID as payload.
    3. The Mini App calls `openInvoice` and refetches entitlements once it closes.
    4. The bot's `pre_checkout_query` handler re-validates the payload, amount, user status and band, and answers within Telegram's deadline (~10 s) with a localized error on rejection.
    5. On `successful_payment` the bot marks the payment `paid` and grants the entitlement in one transaction. This is idempotent on `telegram_payment_charge_id`.
  - Admin `/refund <payment_id>` calls `refundStarPayment` and revokes the entitlement.
  - `/paysupport` command (check Telegram's current requirements for Stars sellers).
- Free-tier limits: `domain/limits/quota.ts` computes daily new matches and open matches from config plus entitlements, used by matching eligibility. The Mini App shows how much is left today and when the next run is.
- Minimalist visual pass:
  - Telegram theme params mapped to design tokens (bg, text, hint, accent, secondary bg), correct in light and dark;
  - system font stack, 8 px spacing scale, one accent color, tap targets ≥ 44 px;
  - safe-area insets, honoring `prefers-reduced-motion`;
  - SDK haptics on swipe and submit;
  - the swipe gesture built on pointer events and CSS transforms (no animation library);
  - empty, loading and error states for every screen;
  - interest picker, "All" tab: order items so the most commonly picked ones come first, with `mainstream` before `known` before `niche`, and music and games before books. Phase 1 orders by item ID, so the tab starts with books (decided 2026-10-03, product owner; the exact sort key is settled in Phase 6);
  - copy review in ru and en;
  - checks on iOS, Android and Desktop Telegram;
  - CI: a size-limit bundle budget step (moved from Phase 0): ≤ 150 KB gzip of initial JS (Q33, decided).
- Deployment:
  - a multi-stage Dockerfile building one image that serves the API, `/tg/webhook` (checks `X-Telegram-Bot-Api-Secret-Token`) and the static Mini App;
  - `pnpm db:migrate` runs as a release step before start;
  - forward-only expand/contract migrations, so rolling back the image is safe;
  - managed Postgres with daily backups and PITR, plus a restore drill;
  - create the staging bot in @BotFather (moved from Phase 0) and set up the production bot @samesync_bot; separate staging and production bots, databases and secrets;
  - setup automated in code: `setWebhook`, `setMyCommands` per locale, menu button;
  - `/healthz` for the host's health check;
  - pino logs with a tested redaction list;
  - a runbook at `docs/ops.md` (deploy, rollback, rotate the bot token, restore a backup, flip `U18_POOL_ENABLED`).
  - Host choice: Q29. It must account for Russia's personal-data localization requirement for ru users (Q28) and be decided before Phase 6 starts.

**Out of scope.** Choosing paid features or prices, subscriptions (Q27), ads, analytics dashboards beyond `/stats`, multi-region, autoscaling.

**Acceptance criteria**
- [ ] In staging, buying the placeholder product works end-to-end (a real 1-Star purchase, refunded with `/refund`). A duplicate `successful_payment` grants the entitlement once; a refund revokes it.
- [ ] Pre-checkout rejects frozen users, an unknown or disabled product, an amount mismatch, and `u18` users while purchases are off for them.
- [ ] Free-tier limits are enforced in matching and shown correctly in the Mini App.
- [ ] Every screen passes a manual check in light and dark themes on three Telegram clients. Initial JS stays within the 150 KB gzip budget (Q33), enforced by the size-limit CI step.
- [ ] Production runs as one container with the webhook secret checked, migrations applied by the release step, a successful backup restore drill, no PII in a sampled day of logs, and `U18_POOL_ENABLED=false` unless §7 G3 is signed off.

**Tests that prove it**
- `apps/server/test/payments/invoice.test.ts`: currency `XTR`, empty provider token, payload tied to a pending payment, eligibility checks.
- `apps/server/test/payments/precheckout.test.ts`: each rejection case, answered in time.
- `apps/server/test/payments/successful-payment.test.ts`: idempotency under duplicate and out-of-order updates; the grant is atomic.
- `apps/server/test/payments/refund.test.ts`: the refund call, the status change, revoking the entitlement, the audit row.
- `apps/server/test/safety/u18-purchases.test.ts`: `u18` users can't get an invoice or pass pre-checkout while their band isn't allowed.
- `apps/server/src/domain/limits/quota.test.ts`, plus a matching integration test showing quotas and entitlements change eligibility.
- `apps/server/test/http/webhook-secret.test.ts`: a missing or wrong secret gets 401, and the update is not processed.
- `apps/server/test/logging/redaction.test.ts`: the redacted fields never appear in log output.
- CI: build the Docker image and smoke-test it (container starts, `/healthz` returns 200 against a CI Postgres), plus the size-limit budget (≤ 150 KB gzip initial JS).

---

## 7. Release gates

| Gate | Requires |
|---|---|
| **G1 — Internal alpha** (team accounts, adult pool) | Phase 4 done |
| **G2 — Public adult beta** | Phase 5 done; Terms of Service and privacy policy published; Q28 legal review done for the adult/dating features; admins named (Q30); "SameSync" trademark check passed (Q31); launch ru catalog size agreed and met (Q6) |
| **G3 — Enable `u18` pool in production** | G2 plus: Q28 review of minors' data and consent; filter corpus at acceptance level; admin response time for `u18` reports defined and staffed; Q17, Q18 and Q21 answered (Q14–Q16 are decided); launch coverage counting per band × locale revisited (Q6); a dry run in staging with test accounts |
| **G4 — Payments live** | Phase 6 done; Q26 and Q27 answered |

**Launch scope.** The realistic public launch (G2) is the **adult pool only**. The `u18` pool is fully built and tested in Phases 1–5, but `U18_POOL_ENABLED` stays `false` in production until G3 is signed off. Until then, `u18` users who onboard are `waitlisted`.

## 8. Open questions

Each question lists a *provisional* default used until it is answered (implemented as config or content where possible) and the phase that needs the answer.

**Product & core loop**
- **Q1. Is the game required before chatting?** The loop implies yes, but it isn't stated. *Provisional:* yes; chat opens at `results_ready`. *Needed by:* Phase 3.
- **Q2. When does the 48h clock start, and what about later silence?** ✅ **Decided (2026-10-02, product owner):** the game has 48h from match creation; chat has 48h from `results_ready` if no message is sent; nothing expires after the first message; one reminder each.
- **Q3. How many game questions?** "Several". *Provisional:* 5, including the closing split. *Needed by:* Phase 3.
- **Q4. Is the opener template-based or LLM-generated, and can the user edit it?** "Pre-generated" is ambiguous, and no LLM is in the stack. An LLM would also send minors' data to a third party. *Provisional:* per-take templates in `content/`, editable before sending. *Needed by:* Phase 3.
- **Q5. Take deck rules.** Fixed or random deck from a larger bank? Is skip allowed? Can answers be edited later? ✅ **Decided (2026-10-03, product owner):** 35 takes drawn per band × mode, skip allowed (≥ 25 non-skip answers required), answers editable later with effect on future matches only.
- **Q6. Interest catalog.** Catalog-only or free-text entries (free text needs moderation, especially for `u18`)? Min/max picks? Who curates, and how big must the ru catalog be at launch? ✅ **Decided (2026-10-03, product owner):** catalog-only (no free-text entries), 5–30 picks per user, a curated catalog maintained by the team (format: `docs/content-format.md`). ✅ **Decided (2026-10-03, product owner):** `content:check --launch` keeps counting items per locale for now (≥ 150 each; the launch content has 187 ru / 157 en). Counting per band × locale must be revisited before G3: `u18:en` currently sees only 127 items. **Still open:** how big the ru catalog must be at launch. *Needed by:* G2 (catalog size), G3 (per-band count).
- **Q7. Are photos in the product at all?** ✅ **Decided (2026-10-02, product owner):** no photos anywhere in the MVP.
- **Q8. Matching cadence.** Continuous small runs, or scheduled "drops" (which concentrate activity and help cold start)? Drops in which timezone? *Provisional:* configurable cron, twice daily per pool, times in Europe/Moscow for ru and UTC for en. *Needed by:* Phase 2.
- **Q9. Rematch policy.** Can an expired pair ever be matched again? *Provisional:* never (UNIQUE pair). *Needed by:* Phase 2.
- **Q10. Adult modes.** Can an adult be in friends and dating at once? What happens to open matches when they switch? ✅ **Decided (2026-10-03, product owner):** one mode at a time, switchable in settings; open matches stay open when the mode changes.
- **Q11. Dating gender and preference model.** Which gender options, and is "seeking" multi-select? ✅ **Decided (2026-10-03, product owner):** dating mode asks **"You are"** (man / woman, single choice) and **"Looking for"** (men / women, multi-select, at least one). A match requires mutual compatibility: each user's gender is in the other's "looking for". The option list lives in `content/` so it can be extended later; `users.gender` and `users.seeking` store option IDs (format: `docs/content-format.md`). The two extra fields are accepted as part of onboarding. Legal review of dating features is still covered by Q28.
- **Q12. Age gaps in the adult pool.** The spec limits age gaps only for `u18`. Should an 18-year-old be matched with a 45-year-old, especially in dating? *Provisional:* dating gets a user-set age range defaulting to ±5 years; friends has no limit. Product decision needed. *Needed by:* Phase 2.
- **Q13. Choosing and switching language.** Picked by the user or taken from `language_code`? Where do `uk`/`be`/`kk`… go? Does switching move pools and close open matches? Can bilingual users join both pools? ✅ **Decided (2026-10-03, product owner):** preselected from `language_code` (`ru` → ru, otherwise en), then stored in `users.locale`; changeable only in SameSync's settings; a change affects future matches only; one language pool per user. Consequence: after the first use, changing the Telegram client's language does **not** change SameSync's language. Phase 1 makes the bot and the Mini App read the stored locale (Phase 0 still follows the live `language_code`).

**Age & safety**
- **Q14. What does "±2 years" mean?** ✅ **Decided (2026-10-02, product owner):** birth dates at most 2 calendar years apart (the stricter reading; constant over time). The looser whole-year-age reading was rejected.
- **Q15. Which timezone decides birthdays, and how are Feb 29 births handled?** ✅ **Decided (2026-10-03, product owner):** the UTC calendar date decides birthdays; people born on Feb 29 have their birthday on Mar 1 in non-leap years (matches Postgres `age()`).
- **Q16. Under-14 users.** Should their birth date be kept (so they can't retry with another) or nothing stored? Do they become eligible automatically at 14? ✅ **Decided (2026-10-03, product owner):** keep `birth_date` with status `ineligible` and nothing else (so they can't retry with another date); they become eligible on their 14th birthday.
- **Q17. Policy for birth-date corrections.** How do users ask (provisional `/support`), what proof is needed, and do adult → `u18` corrections (a grooming vector) need extra scrutiny, such as a second admin? *Needed by:* Phase 5.
- **Q18. Auto-freeze settings.** The value of N, the window, a lower threshold for `u18`, and whether age-misrepresentation reports freeze sooner. *Provisional:* 3 distinct reporters in 30 days (adults), 2 (`u18`); age-misrepresentation reports alert admins immediately but count normally. *Needed by:* Phase 5.
- **Q19. 18+ chat content.** The spec restricts media only for `u18`. Is adult chat text-only too? Should contacts be filtered in adult chat before a reveal? *Provisional:* text-only in both pools, no contact filter for adults. *Needed by:* Phase 4.
- **Q20. Retention.** How long are message bodies, report evidence and filtered (blocked) message bodies kept? Moderation needs evidence, and privacy argues for less. *Provisional:* messages 30 days; evidence until the report is resolved + 90 days; filtered bodies stored with the same retention and shown to admins only inside reports. *Needed by:* Phase 4.
- **Q21. Age verification beyond self-declaration.** Adults posing as minors is the biggest residual risk (§9). *Provisional:* none in the MVP; the risk is accepted, documented and reduced as §9 describes. *Needed by:* G3.
- **Q22. Quiet hours.** Should there be no notifications at night, especially for minors? That needs the user's timezone, which Telegram doesn't provide. *Provisional:* capture the IANA timezone from the Mini App (`Intl`) and hold notifications 23:00–08:00 local. *Needed by:* Phase 2.
- **Q23. Account deletion and data export.** Not in the spec, but likely legally required. *Provisional:* `/delete` in Phase 5 (anonymize, keep only safety and audit records); export postponed. *Needed by:* Phase 5.

**Chat**
- **Q24. Routing between several chats in one bot DM.** Bot API 9.3 added topics in private chats with bots (one topic per match would be the cleanest UX), but there are reports of regressions in 2026. *Provisional:* `active_match_id` pointer plus reply-to routing; re-evaluate topics after Phase 4. *Needed by:* Phase 4.
- **Q25. Reveal edge cases.** What if a user has no username? Does the relay chat stay open after a reveal? *Provisional:* a username is required (the user is asked to set one); the chat stays open until someone leaves. *Needed by:* Phase 4.

**Monetization**
- **Q26. Are purchases allowed in the under-18 pool?** (Raised in the spec.) *Provisional:* off, through a per-band `bands_allowed` on each product. *Needed by:* G4.
- **Q27. Paid features, prices, free-tier numbers, one-off vs subscription.** *Provisional:* 3 new matches a day, 5 open matches, one-off purchases only, a placeholder product outside production. *Needed by:* G4.

**Legal & operations**
- **Q28. Legal review (blocks public launch).** Topics:
  - Terms of Service and privacy policy;
  - consent and processing of 14–17-year-olds' data (rules on parental consent differ by country);
  - dating data that may reveal sexual orientation (special-category data in many jurisdictions, and restricted content rules in some target markets);
  - data residency: hosting for ru users must account for Russia's personal-data localization requirement (where the database holding their data may live). Decide before Phase 6 (see Q29);
  - Telegram's own terms for Mini Apps and bots, including its minimum-age rules;
  - consumer rules for purchases by minors.

  *Needed by:* G2 and G3.
- **Q29. Hosting, domain, repo host and CI, error tracking.** ✅ **Repo and CI decided (2026-10-02, product owner):** GitHub + GitHub Actions. **Still open:** hosting is decided in Phase 6, and must account for Russia's personal-data localization requirement for ru users (Q28); decide it before Phase 6 starts. Domain and error tracking are also open. *Provisional:* any Docker host with managed Postgres in the jurisdiction Q28 picks; no third-party error tracker (logs only). *Needed by:* Phase 6.
- **Q30. Admin team.** Who are the admins, what response time applies to `u18` reports, and where do alerts go? *Provisional:* DMs to every ID in `ADMIN_TELEGRAM_IDS`. *Needed by:* Phase 5, G2.
- **Q31. Name.** ✅ **Decided (2026-10-02):** the product is named **SameSync** and the production bot is **@samesync_bot** (it was "VibeCheck" before). **Still open:** a trademark check for "SameSync" in the target markets. *Needed by:* G2.

**Technical**
- **Q32. Which "official Telegram Mini Apps SDK"?** Telegram's own client library is the `telegram-web-app.js` script (`window.Telegram.WebApp`: no npm package, no tree-shaking). The React SDK most projects use is the community-maintained tma.js project, whose npm scope has moved between `@telegram-apps/*` and `@tma.js/*`. ✅ **Decided (2026-10-02, product owner):** `@tma.js/sdk-react`, wrapped in `apps/miniapp/src/platform/` so it can be swapped. **Verified in Phase 0 (2026-10-03):** `@tma.js/sdk-react@3.0.23` on `@tma.js/sdk@3.3.0`; neither it nor `@telegram-apps/sdk-react` is deprecated on npm, so the decision stands. The subset we use (`init`, `isTMA`, `retrieveRawInitData`, `themeParams`, `miniApp`) costs ≈ 23 KB gzip. `mockTelegramEnv` (dev browser mode) is stripped from production builds (verified by an A/B build).
- **Q33. Bundle budget.** ✅ **Decided (2026-10-03, product owner):** ≤ **150 KB gzip** for initial JS (raised from the provisional 100 KB of 2026-10-02), because React 19 + ReactDOM alone take ≈ 67 KB gzip. Enforced by a size-limit CI step from Phase 6. **Phase 0 measurement (2026-10-03):** initial JS is 88.5 KB gzip (React 19.3 + ReactDOM ≈ 67 KB, SDK ≈ 23 KB), which leaves ≈ 61.5 KB for the product UI of Phases 1–5. Code-splitting screens out of the initial chunk stays the first tool if that gets tight.

## 9. Main risks

The public launch is planned as **adult pool only** (§7). The `u18` pool stays built but disabled until G3, so at launch the minor-specific risks below apply to staging and dry runs, not to real users, and only the adult pools (`adult:ru`, `adult:en` × friends/dating) need liquidity.

| Risk | Why it matters | Mitigations in this plan | Residual |
|---|---|---|---|
| **Adults posing as minors** (and minors posing as adults) | Birth dates are self-declared. This is the most serious harm the product could enable. | Write-once birth date (no flip-flopping); ±2y window in `u18`; friends-only; text-only; contact/link filter including obfuscation and split messages; usernames never revealed or stored for `u18`; no photos; age-misrepresentation report reason with immediate admin alert; lower freeze threshold in `u18`; audited corrections with extra scrutiny for adult → `u18` (Q17); `u18` pool gated behind G3 | Real age can't be verified (Q21). Treat it as a known, documented risk and revisit verification after launch. |
| **Cold start** | Matching needs enough users per pool × mode. An empty "waiting" state kills retention. | Scheduled drops concentrate activity (Q8); fallback tiers; small-pool priors so rarity works from day one; launch ru first with en behind a flag if it's thin; honest waiting copy plus a notification when a match lands; `/stats` liquidity monitoring; seed through niche communities that match the catalog's niches | The tiers trade match quality for liquidity. Watch tier-3 share in `match_runs`. |
| **Pool fragmentation** | 2 bands × 2 locales × modes gives 6 pools; then the `u18` ±2y window and dating gender/age filters cut each one further. | Adult-only launch removes the two `u18` pools at first; rarity stats shared across modes within a pool; tiers; per-pool liquidity in `/stats`; option to delay the en locale or dating mode until a pool has enough users | Small `u18` age cohorts and minority dating preferences may still wait a long time. |
| **Abuse: harassment, spam, scams, report brigading** | Anonymous chat attracts abuse, and false reports can be used as a weapon. | Report and block everywhere; distinct-reporter counting; admin review and unfreeze; rate limits on messages and matches (free-tier limits); bot reachability checks; audit log | Moderation is manual through bot commands, which won't scale. Plan a web panel when report volume justifies it. |
| **Filter evasion** | Determined users will find ways around a text filter. | Normalization, homoglyphs, number words, sliding window; fail closed; production bypasses go into the corpus; escalation of repeated hits | No text filter is complete, so it's backed by reports and freezes. |
| **Deanonymization** | A very niche shared item or the timing of messages could identify someone in a small pool. | Teasers use content IDs only; no counts shown; aliases change per match; no forwarding; no names | Small pools carry an inherent risk. Consider hiding teaser items shared by < k users. |
| **Telegram platform** | Bot API rate limits, Bot API changes or regressions (e.g. private-chat topics), Mini App policy, regional restrictions on Telegram in target markets | Outbox throttling; the SDK wrapped behind `platform/`; no reliance on unstable Bot API features in the MVP | Platform availability is outside our control. |
| **Legal / compliance** | Minors' data, dating data, data residency, purchases by minors | Data minimization (no `u18` usernames, no photos, retention limits); `u18` and payment gates; Q28 review before public launch | Unknown until legal review. This plan is not legal advice. |
| **Single-process limits** | Heavy matching could stall the bot or API. | Scoring in a worker thread; advisory locks and SKIP LOCKED make a second instance possible; candidate-index optimization planned past a measured threshold | Fine for MVP scale. |
| **Content staleness** | Memes and niche items age quickly. A thin ru catalog weakens matching. | Versioned content with retirement; curator-set priors; `content:check` in CI | Needs an owner and a regular update rhythm (Q6). |
