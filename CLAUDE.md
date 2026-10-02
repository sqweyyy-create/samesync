# CLAUDE.md — SameSync

SameSync (bot: @samesync_bot; trademark check still pending, see PLAN.md Q31) is a Telegram Mini App plus a Telegram bot that helps Gen Z users meet through shared *specific* interests and opinions. Russian is the main locale and English is second. The visual style is minimalist.

**Status:** planning is done and there is no application code yet. [PLAN.md](PLAN.md) holds the phase plan, data model, matching approach, open questions and risks. Read its status table before you start any work.

## Product summary

1. **Onboarding** (Mini App): the user enters a birth date (set once and never editable by the user), picks a mode, and fills a *swipe profile*: ~30–40 agree/disagree "hot takes" plus picks from an interest catalog (artists, games, shows, memes…). The swipe profile is the whole profile. There are no long forms and no photos anywhere in the MVP (PLAN.md Q7).
2. **Matching** (scheduled batch job, not realtime): pairs users whose answers and interests overlap. Rare overlaps count far more than common ones. When a pool is thin, the job falls back to broader overlaps. The bot notifies both users with a teaser of the specific overlap.
3. **Game** (async, Mini App): each user predicts the other's answers to a few questions. The results show how well they read each other and always end on one disagreement ("You split on this one. Ask why."), with a pre-generated first message.
4. **Chat** (bot DM): anonymous text that the bot relays. A match expires after 48h if nobody writes. In the 18+ pool both users can agree to reveal Telegram usernames. In the under-18 pool usernames are never revealed.

These are also part of the MVP: report, block, auto-freeze, admin commands in the bot, Telegram Stars payment plumbing, and free-tier limits.

## Stack

Decided by the product owner:
- TypeScript everywhere, single repo.
- Mini App: Vite + React + Telegram Mini Apps SDK (`@tma.js/sdk-react`, PLAN.md Q32). The bundle must stay small (≤ 100 KB gzip initial JS, Q33).
- Backend: **one** Node process that runs the grammY bot, a lightweight HTTP API and the scheduled jobs.
- Auth: Telegram `initData` validated on the server only. No custom login.
- PostgreSQL with a typed ORM. **No Redis, no WebSockets.**
- i18n from day one (ru, en). Matching pools are also split by language.
- The question bank and interest catalog live in versioned JSON files in `content/`, never hardcoded.

Chosen in PLAN.md §2 (change one only by recording a decision there): pnpm workspaces, Node 24 LTS (ESM), Hono (HTTP), Drizzle ORM + drizzle-kit, PostgreSQL 17+, zod, Vitest + Testing Library + fast-check, pino, a small in-house i18n built on `Intl.PluralRules`, an in-process scheduler with Postgres advisory locks and an outbox table, and Docker for deploys.

## Repo layout (target, created in Phase 0)

```
apps/
  server/                 # ONE process: bot + HTTP API + scheduler
    src/
      main.ts             # composition root
      config.ts           # zod-validated env
      domain/             # pure logic: age, pools, scoring, game, filters. No I/O, no Date.now()
      services/           # use-cases: domain + repositories
      db/                 # Drizzle schema, repositories, migrations/ (SQL triggers live here)
      http/               # Hono routes, initData auth middleware
      bot/                # grammY: commands, relay, admin, payments
      jobs/               # scheduler, matching run, expiry, age transition, outbox sender, purge
      content/            # loads + validates /content at startup
    test/
      safety/             # pool isolation and minor-safety suites. NEVER skipped
  miniapp/                # Vite + React
    src/
      platform/           # the ONLY place that imports the Telegram SDK
      api/  screens/  ui/
packages/
  shared/                 # zod API schemas, domain types, ageOn(), i18n runtime + locales/{ru,en}.json
content/                  # questions/, interests/, openers, aliases, products.json, schemas; content.lock.json from Phase 1
```

## Non-negotiable safety invariants

Age bands: `u18` = 14–17, `adult` = 18+. The band always comes from `birth_date` through `ageOn()` (TypeScript, `packages/shared`) or its SQL twin `vc_age_years()`. A test checks that the two agree. Users under 14 get no profile and no matching.

1. **No cross-band contact, ever.** A `u18` user and an `adult` user must never be matched, never be notified about each other, never exchange a message, and never see each other's answers, game data or aliases. This must hold even if a cached field is stale, a client lies, or a code path forgets a check.
2. **The data layer enforces it.** Postgres constraints and triggers guard every cross-user write (match, message, game prediction, reveal consent). They re-derive both users' bands from `birth_date`. App code checks too, but the database is the backstop. Never drop, disable or work around these triggers (`DISABLE TRIGGER`, `session_replication_role`, superuser connections from the app) without explicit human approval.
3. **Re-check right before sending.** The outbox sender and the chat relay re-check band equality, match state and freeze status immediately before every Telegram call. `users.age_band` is a cache for indexing only. It must never be the only basis for a safety decision.
4. **A band change closes everything.** When a user's band changes (18th birthday or an admin birth-date correction), the same transaction closes all their open matches and chats, cancels their pending notifications, and makes the counterparts' data from those matches unreadable.
5. **Under-18 rules:**
   - Friends mode only.
   - Partners' birth dates must be at most 2 calendar years apart (PLAN.md Q14, decided).
   - Plain text only: no photos, voice, video, stickers, files or formatting entities.
   - Every message passes the contact/link filter before it is relayed. If the filter throws, the message is not delivered.
   - Matching fallback tiers never relax any of these rules.
6. **Usernames:**
   - In the `u18` band they are never revealed: not by the reveal feature, not in relayed messages, not in notifications, not in API responses.
   - A `u18` user's username is never stored (DB CHECK).
   - The relay never uses `forwardMessage` or `copyMessage`. It sends a new plain-text message that contains only the alias and the text.
   - Reveal exists only in the adult band, and only after both users consent.
7. **Birth date is write-once.** The user sets it exactly once. Only `admin_set_birth_date()` can change it later: admin-only, a reason is required, and the change is audited. A DB trigger rejects every other change.
8. **Language pools.** Matches form only within one locale, and the database enforces this too.
9. **Frozen users** can't be matched, can't send or receive relayed messages, get no match notifications, and can't call product APIs.
10. **Fail closed.** A missing or unknown birth date or band, a filter error, or failed `initData` validation all lead to *deny*.
11. **Tests guard every invariant.** Each invariant has dedicated tests in `apps/server/test/safety/` (`pnpm test:safety`), including tests that skip the app layer and attack the database directly as the app role. Never skip, weaken or delete these tests to get a change through. If one fails, the change is wrong. Any change to safety tests, safety triggers, auth, relay or filters needs explicit human sign-off.
12. **Production gate for minors.** `U18_POOL_ENABLED` stays `false` in production until the Phase 5 acceptance criteria are met and legal review is done (PLAN.md §7). The planned public launch is adult-only; the `u18` pool is built but disabled until G3.

## Conventions

- **TypeScript:** `strict` + `noUncheckedIndexedAccess`. No `any` (lint-enforced). ESM only.
- **Validation:** zod at every boundary: env, HTTP bodies, bot callback data, content files. API request/response schemas live in `packages/shared` and both apps use them.
- **Layering:**
  - `domain/` is pure and gets `now` as a parameter.
  - `services/` orchestrate.
  - Only `db/` repositories run queries.
  - Bot and HTTP handlers stay thin.
  - Any read of another user's data goes through a participant-scoped repository function (e.g. `getMatchForParticipant(userId, matchId)`). There are no bare "get user by id" calls in user-facing paths.
- **Auth:**
  - Every API call sends `Authorization: tma <raw initData>`. The server validates the HMAC and the `auth_date` age.
  - User identity comes only from validated initData, never from a body or query.
  - There are no auth-bypass flags. For local dev, `pnpm dev:initdata` signs initData with the dev bot token.
- **Time:** inject a `Clock`. No `new Date()` / `Date.now()` in domain or services. Age uses the UTC calendar date until Q15 is decided.
- **IDs:** rows use uuid v7. Each user also has a short `public_id`, a support code that admins and the user can see. Never show a `telegram_id` to other users.
- **i18n:**
  - No user-facing string literals anywhere: bot replies, UI, notifications, user-visible errors, invoice titles, admin replies.
  - Keys live in `packages/shared/src/i18n/locales/{ru,en}.json`. `ru` is the source locale, and ru and en are added in the same change.
  - Plurals follow `Intl.PluralRules` categories.
  - **Russian copy that addresses the user must be gender-neutral**, because we don't know their gender.
  - Content (questions, interests, openers) carries its own ru/en text in `content/`.
- **Content:** IDs are permanent. Never change what an ID means: retire it and add a new one. A typo fix needs a `revision` bump (enforced by `content.lock.json` from Phase 1). `pnpm content:check` must pass.
- **Database:**
  - Drizzle schema lives in `apps/server/src/db/schema/`. Migrations are generated and committed.
  - Triggers, functions and CHECKs go in hand-written SQL migrations.
  - Never edit an applied migration. Use expand/contract for breaking changes.
  - The app connects as `samesync_app`, a role that is not the table owner and can't alter or disable triggers.
- **Bot:**
  - Relayed text goes out as plain text with no `parse_mode`.
  - Proactive messages go through the outbox (throttled, retried, de-duplicated). Direct replies to a user's own command can be sent inline.
- **Logs:** pino JSON. Never log message bodies, birth dates, usernames, initData or payment payloads. Log internal IDs instead.
- **Mini App:**
  - The Telegram SDK is imported only in `src/platform/`.
  - No UI kits, no web fonts.
  - Locale JSON and content are loaded at runtime, not bundled.
  - The size budget is enforced in CI from Phase 6 (size-limit).
- **Tests:** Vitest. DB tests run against real Postgres; safety tests never mock the database. Matching invariants use property-based tests (fast-check). `.only` and `.skip` are lint errors.
- **Commits:** small, one concern each, Conventional Commits.

## Run & test

These commands are planned. Phase 0 creates them, so if one is missing, adding it is Phase 0 work.

```bash
pnpm install
cp .env.example .env            # BOT_TOKEN, DATABASE_URL, MINIAPP_URL, ADMIN_TELEGRAM_IDS, U18_POOL_ENABLED, ...
docker compose up -d db         # local Postgres
pnpm db:migrate
pnpm content:seed
pnpm dev                        # server (bot long-polling + API + jobs) and Vite dev server
pnpm dev:initdata               # prints signed initData for opening the Mini App in a plain browser
pnpm lint && pnpm typecheck && pnpm test
pnpm test:safety                # pool isolation and minor-safety suites only
pnpm content:check
pnpm build
```

To test inside Telegram, create a separate dev bot in @BotFather. The Mini App URL must be HTTPS, so point it at a tunnel (e.g. cloudflared) to the Vite dev server. Production runs the bot through a webhook with a secret token, and the same process serves the built Mini App.

## Working rules

- Work one phase at a time, in PLAN.md order. A phase is done only when all its acceptance criteria are met and its status row is updated.
- **Every phase and every PR keeps `pnpm lint && pnpm typecheck && pnpm test` green, and CI must be green before merge.** Don't disable tests, don't skip the safety suite, don't mark a phase done while anything is red.
- New behavior ships with tests in the same change. A bug fix starts with a failing regression test.
- If something is ambiguous, don't guess. Add it to PLAN.md "Open questions" (with a provisional default if work has to continue) and tell the user.
- In a PR that touches auth, relay, filters, matching eligibility, DB triggers or `test/safety/`, say which invariant is affected and how it stays intact.
- Keep this file and PLAN.md up to date when decisions change.
