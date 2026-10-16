# CLAUDE.md — SameSync

SameSync (bot: @samesync_bot; trademark check still pending, see PLAN.md Q31) is a Telegram Mini App plus a Telegram bot that helps Gen Z users meet through shared *specific* interests and opinions. Russian is the main locale and English is second. The visual style is minimalist.

**Status:** Phases 0–4 (scaffold, onboarding, matching engine, game, anonymous chat) are done. Phase 5 (safety & admin tooling) is implemented and waits for the manual check and the product owner's sign-off; see the status table. Two Phase 4 items are deferred live checks on a phone before the public launch (PLAN.md §7). [PLAN.md](PLAN.md) holds the phase plan, data model, matching approach, open questions, risks and per-phase implementation notes. Read its status table before you start any work.

## Product summary

1. **Onboarding** (Mini App): the user enters a birth date (set once and never editable by the user), picks a mode, and fills a *swipe profile*: ~30–40 agree/disagree "hot takes" plus picks from an interest catalog (artists, games, shows, memes…). The swipe profile is the whole profile. There are no long forms and no photos anywhere in the MVP (PLAN.md Q7).
2. **Matching** (scheduled batch job, not realtime): pairs users whose answers and interests overlap. Rare overlaps count far more than common ones. When a pool is thin, the job falls back to broader overlaps. The bot notifies both users with a teaser of the specific overlap.
3. **Game** (async, Mini App): each user predicts the other's answers to a few questions. The results show how well they read each other and always end on one disagreement ("You split on this one. Ask why."), with a pre-generated first message.
4. **Chat** (bot DM): anonymous text that the bot relays. A match expires after 48h if nobody writes. In the 18+ pool both users can agree to reveal Telegram usernames. In the under-18 pool usernames are never revealed.

These are also part of the MVP: report, block, auto-freeze, admin commands in the bot, Telegram Stars payment plumbing, and free-tier limits.

## Stack

Decided by the product owner:
- TypeScript everywhere, single repo.
- Mini App: Vite + React + Telegram Mini Apps SDK (`@tma.js/sdk-react`, PLAN.md Q32). The bundle must stay small (≤ 150 KB gzip initial JS, Q33).
- Backend: **one** Node process that runs the grammY bot, a lightweight HTTP API and the scheduled jobs.
- Auth: Telegram `initData` validated on the server only. No custom login.
- PostgreSQL with a typed ORM. **No Redis, no WebSockets.**
- i18n from day one (ru, en). Matching pools are also split by language.
- The question bank and interest catalog live in versioned JSON files in `content/`, never hardcoded.

Chosen in PLAN.md §2 (change one only by recording a decision there): pnpm workspaces (pnpm 12), Node 24 LTS (ESM), TypeScript 6.0 (not 7: typescript-eslint doesn't support it yet), Hono (HTTP), Drizzle ORM + drizzle-kit, PostgreSQL 17+, zod (zod/mini in code the Mini App bundles), Vitest + Testing Library + fast-check, ESLint 10, pino, a small in-house i18n built on `Intl.PluralRules`, an in-process scheduler with Postgres advisory locks and an outbox table, an esbuild bundle for the server, and Docker for deploys.

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
    scripts/              # CLIs: migrate, content:seed, dev:* tooling, bench:matching
    test/
      safety/             # pool isolation and minor-safety suites. NEVER skipped
  miniapp/                # Vite + React
    src/
      platform/           # the ONLY place that imports the Telegram SDK
      api/  screens/  ui/
packages/
  shared/                 # zod API schemas, domain types, ageOn(), i18n runtime + locales/{ru,en}.json
content/                  # questions/, stances/, interests/, openers/, aliases/, products.json, schemas; content.lock.json from Phase 1
docs/                     # content-format.md (authoring reference for content/)
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
  - `apps/server/src/http/auth/init-data-signer.ts` is for dev scripts and tests only; ESLint forbids importing it from runtime code.
- **Time:** inject a `Clock`. No `new Date()` / `Date.now()` in domain or services. Age uses the UTC calendar date; Feb 29 birthdays fall on Mar 1 in non-leap years (PLAN.md Q15, decided).
- **IDs:** rows use uuid v7. Each user also has a short `public_id`, a support code that admins and the user can see. Never show a `telegram_id` to other users.
- **i18n:**
  - No user-facing string literals anywhere: bot replies, UI, notifications, user-visible errors, invoice titles, admin replies.
  - Keys live in `packages/shared/src/i18n/locales/{ru,en}.json`. `ru` is the source locale, and ru and en are added in the same change.
  - Plurals follow `Intl.PluralRules` categories.
  - **Russian copy that addresses the user must be gender-neutral**, because we don't know their gender.
  - Content (questions, interests, openers) carries its own ru/en text in `content/`.
- **Content:** the file format is specified in `docs/content-format.md`; update it in the same change as `content/src/schema.ts`. IDs are permanent. Never change what an ID means: retire it and add a new one. A typo fix needs a `revision` bump (enforced by `content.lock.json` from Phase 1). `pnpm content:check` must pass.
- **Database:**
  - Drizzle schema lives in `apps/server/src/db/schema/`. Migrations are generated and committed.
  - Triggers, functions and CHECKs go in hand-written SQL migrations.
  - Never edit an applied migration. Use expand/contract for breaking changes.
  - The app connects as `samesync_app`, a role that is not the table owner and can't alter or disable triggers.
  - Migrations create `samesync_app` NOLOGIN and grant per table (least privilege, no DELETE unless needed). Passwords never go in migrations: the login is set by `infra/postgres/init` locally and by the hosting provider in production.
  - Every new table needs explicit grants to `samesync_app` in its migration, plus a test that the app role can do exactly what it needs.
  - Tests run app code as `samesync_app` (`appRolePool()` in `apps/server/test/support/db.ts`), never as the owner.
  - Raw `db.execute(sql…)` results come back with timestamps as text (Drizzle's parsers). Select epoch milliseconds (`(extract(epoch FROM x) * 1000)::float8`) when a repository needs a time.
- **Matching (Phase 2):**
  - `domain/matching/plan.ts` is pure and runs in a worker thread (`jobs/matching-worker.ts`); keep it free of I/O and of runtime imports beyond `@samesync/shared`.
  - A run only proposes pairs. Each match is inserted in its own transaction and the `matches` trigger decides; a refused pair is skipped and counted, never forced.
  - Scheduled jobs take a Postgres advisory lock (`jobs/advisory-lock.ts`).
  - `users.synthetic` marks dev-tooling users: never messaged, and ignored when `NODE_ENV=production`.
- **Game (Phase 3):**
  - `domain/game/` is pure. A match's game is picked inside the match transaction and keeps a snapshot of both users' answers (`games.answers_a` / `answers_b`); results use the snapshot, never the `answers` table.
  - The other person's answers and guesses are read only through `getResultsForParticipant`, whose query selects them only once both players have finished. `GET …/game` carries the questions and nothing else.
  - Guesses are submitted once, through `GamesRepository.submitPredictions` (one transaction). The app role can't update or delete a prediction.
  - Every notification kind needs its rule in `dropReason` (`domain/notifications.ts`): what state the match must be in for the message to still be right.
- **Chat (Phase 4):**
  - Everything that is relayed goes through `services/relay.ts` (`send`): a message written in the bot, the first message from the Mini App, the dev tooling. It stores the message first (the `messages` insert trigger decides), reads the match and both users again right before every Telegram call, and sends a new `sendMessage` with the alias and the text, nothing else.
  - `domain/chat/` is pure: `refusal()` says whether a message may go between two users, `chooseRoute()` where it goes (Q24), and `screen()` is the screening hook where Phase 5 plugs in the contact filter.
  - **The `u18` chat is open only behind the contact filter (Phase 5).** `CHAT_BANDS` lists both bands, `screen()` runs the filter on every `u18` message and refuses without a filter and on any error of it, and the `messages` trigger no longer refuses the band (migration 0014). None of them looks at `U18_POOL_ENABLED`: while the pool is off, `u18` users are waitlisted and can't chat anyway.
  - `users.active_match_id` is a routing hint only. Never base anything on it: the relay checks the match behind it for every message.
  - A username appears in exactly one place: the `reveal_done` notification, composed by the outbox sender, which reads it from Telegram at that moment (`services/usernames.ts`). Never store, log or pass on a username anywhere else.
  - A consent to reveal can be withdrawn until the reveal has happened, never afterwards (Q38, decided): the `reveal_consents` delete trigger (migration 0012) refuses to remove a revealed consent, and the reveal locks both consent rows first.
  - The text of a message never goes into a log or an error. The driver's error for a failed insert quotes its parameters, so `ChatRepository.store` replaces it.
  - Inline button data is built and parsed by `domain/chat/callbacks.ts` (zod). It names an action and a match; the services decide whether the user may do that.
- **Safety and admin (Phase 5):**
  - The contact filter is `domain/safety/contact-filter.ts`, pure: `findContact(text)` and `findContactInWindow(recent, text)`. The relay runs it on every `u18` message together with the sender's last delivered messages of that chat (`services/contact-filter.ts`). A hit stores the message as `blocked_by_filter` (evidence for a report, never sent), writes a `filter_events` row and, after the threshold, a system report. Every evasion found in production goes into `apps/server/test/fixtures/contact-filter/{ru,en}.json` first, as a failing test.
  - Reports and blocks are only ever about the other person of a match the caller is in (`SafetyRepository.participantOf`, the participant scope), and the `reports` and `blocks` triggers check that again. A block closes the pair's open match inside the database (`blocks_90_close_matches`); the app only adds the neutral `chat_ended` notice.
  - A freeze is `status = 'frozen'` and nothing else: the state-change trigger closes the matches and cancels the notifications; `users.frozen_at` follows the status by trigger. Only `SafetyService.freeze`/`unfreeze` change it, and every change writes `admin_actions` (the bot's own ID is the actor of an automatic freeze). A frozen user still gets `account_frozen` and `support_reply` notifications and can use `/support`; nothing else.
  - Admin commands live in `bot/admin.ts`, for `ADMIN_TELEGRAM_IDS` only, re-checked on every command and every button. Anyone else gets the unknown-command reply, and the commands are not in the menu. A command that can't be undone asks for a tap on a reply to the admin's own message (`domain/safety/callbacks.ts`); nothing is kept in memory between the two. Admins see support codes, statuses, bands and counts: never a name, a username, or messages outside the evidence a report kept. Viewing evidence is audited too.
  - `admin_set_birth_date()` and `user_delete_account()` are the only ways to change a birth date or delete an account; both are granted to the app role on purpose (migration 0014) and guarded by the admin check and the confirmation.
  - Alerts to admins go straight to the Bot API (`services/admin-alerts.ts`): admins need not be users, so the outbox can't carry them. Best effort, logged.
  - Thresholds and windows are `DEFAULT_SAFETY_PARAMS` (`domain/safety/params.ts`), provisional per Q18 and Q20.
- **Dev tooling:**
  - Scripts live in `apps/server/scripts/`, their libraries in `scripts/lib/`. They refuse to run with `NODE_ENV=production`, before they touch anything.
  - `pnpm dev:up` reads `.env` only for `BOT_TOKEN` and `DATABASE_URL`, never prints, logs or copies a value (except the one backup in `.dev/`), and doesn't load `.env` into its own environment, so the processes it starts read the updated file themselves.
  - Scenarios (`scripts/lib/scenarios.ts`) act only through the existing dev tools and the real services, as the app role, never with SQL that bypasses a trigger. They touch only the developer's matches and synthetic users, and refuse when another real user is active in the same pool. Their checklists render the expected texts from the catalogs.
  - `reset` retires synthetic users (status `deleted`, so the state-change trigger closes their matches) instead of deleting them: the app role has no DELETE.
- **Bot:**
  - Relayed text goes out as plain text with no `parse_mode`.
  - Proactive messages go through the outbox (throttled, retried, de-duplicated). Direct replies to a user's own command can be sent inline.
- **Logs:** pino JSON. Never log message bodies, birth dates, usernames, initData or payment payloads. Log internal IDs instead.
- **Mini App:**
  - The Telegram SDK is imported only in `src/platform/`.
  - No UI kits, no web fonts.
  - Locale JSON and content are loaded at runtime, not bundled.
  - The size budget (≤ 150 KB gzip initial JS) is enforced in CI from Phase 6 (size-limit).
- **Tests:** Vitest. DB tests run against real Postgres; safety tests never mock the database. Matching invariants use property-based tests (fast-check). `.only` and `.skip` are lint errors.
- **Commits:** small, one concern each, Conventional Commits.

## Run & test

Prerequisites: Node 24 (`.nvmrc`; use it locally too, so results match CI), pnpm 12 (`npm i -g pnpm@12`), Docker. The Docker CLI may only have the standalone `docker-compose` binary; it works the same as `docker compose`.

```bash
pnpm install
cp .env.example .env            # then fill in BOT_TOKEN, MINIAPP_URL, passwords and the three DB URLs
docker compose up -d db         # local Postgres 17; creates samesync_app from APP_DB_PASSWORD on first start
pnpm db:migrate                 # as the owner role (MIGRATION_DATABASE_URL)
pnpm content:seed               # content IDs + release into the DB (owner role); the server won't start without it
pnpm dev                        # server (bot long-polling + API + jobs) and Vite dev server
pnpm dev:up                     # everything for a check in Telegram: Docker + db, migrate + seed, a cloudflared tunnel, MINIAPP_URL in .env and the bot's menu button, then pnpm dev (Ctrl+C stops it and the tunnel)
pnpm dev:down                   # stops pnpm dev, the tunnel and the db container (volumes are kept)
pnpm dev:scenario <phase2|phase3|phase4|phase5|reset> [support code]   # a ready-to-look-at state for the manual check of a phase, and its checklist (phase5 also prints the .env line that makes your account an admin)
pnpm dev:initdata               # signed initData + a URL to open the Mini App in a plain browser
pnpm dev:population --pool adult:ru --mode friends --n 500   # synthetic users for one pool × mode
pnpm dev:match-me <public_id>   # match a real dev user with synthetic ones and send them the bot notification
pnpm dev:match-me <public_id> --counterpart-plays   # …and let the synthetic counterpart play, so the game can be finished alone
pnpm dev:say <match id or alias> "<text>"   # the synthetic counterpart writes to you through the real relay (without a text: show that chat)
pnpm dev:reveal <match id or alias>         # the synthetic counterpart consents to the username reveal
pnpm bench:matching             # 5,000-user matching run on a throwaway database (manual benchmark)
pnpm lint && pnpm typecheck && pnpm test
pnpm test:safety                # pool isolation and minor-safety suites only
pnpm content:check              # add --launch for the launch coverage minimums
pnpm content:lock               # after a legitimate text change (bump the entry's revision first)
pnpm build
pnpm format                     # Prettier --write (pnpm lint runs --check)
```

After any content change: bump `content/release.json`, run `pnpm content:lock`, then `pnpm content:seed`. The server checks at startup that the seeded release matches the files. After pulling changes, run `pnpm db:migrate` and `pnpm content:seed` again.

The dev tooling (`dev:*`, `bench:matching`) refuses to run with `NODE_ENV=production`. `pnpm dev:scenario` defaults to the only real user of the local database; every phase scenario starts with `reset`, so running it twice leaves one set of matches. `<public_id>` is the support code shown in the Mini App settings. An alias is the counterpart's name as the bot shows it (`Лиса`, `fox`, `a.fox` or `🦊`); `pnpm dev:say` without arguments lists the chats there are.

Tests need Postgres: they read `TEST_DATABASE_URL` (owner connection to the `postgres` maintenance DB) from the environment or the root `.env`. They create and drop their own throwaway databases.

To test inside Telegram, create a separate dev bot in @BotFather. The Mini App URL must be HTTPS, so it points at a tunnel to the Vite dev server on port 5173; `MINIAPP_DEV_ALLOWED_HOSTS` must allow the tunnel's domain (`.trycloudflare.com`). Vite proxies `/api` to the server, so one tunnel is enough. `pnpm dev:up` does all of it: it starts a cloudflared quick tunnel, changes only the `MINIAPP_URL` line of `.env` (the previous file is kept in `.dev/env.backup`) and points the bot's menu button at the tunnel, so @BotFather is needed only once, to create the bot. `.dev/` is gitignored. Production (Phase 6) runs the bot through a webhook with a secret token, and the same process serves the built Mini App.

pnpm enforces a minimum release age for new package versions. Don't add `minimumReleaseAgeExclude` entries to get around it: pin the previous release instead. Only packages listed under `allowBuilds` in `pnpm-workspace.yaml` may run install scripts.

## Working rules

- Work one phase at a time, in PLAN.md order. A phase is done only when all its acceptance criteria are met and its status row is updated.
- **Every phase and every PR keeps `pnpm lint && pnpm typecheck && pnpm test` green, and CI must be green before merge.** Don't disable tests, don't skip the safety suite, don't mark a phase done while anything is red.
- New behavior ships with tests in the same change. A bug fix starts with a failing regression test.
- If something is ambiguous, don't guess. Add it to PLAN.md "Open questions" (with a provisional default if work has to continue) and tell the user.
- In a PR that touches auth, relay, filters, matching eligibility, DB triggers or `test/safety/`, say which invariant is affected and how it stays intact.
- Keep this file and PLAN.md up to date when decisions change.
- Every phase that adds user-visible behavior also adds a pnpm dev:scenario <phaseN> with a printed checklist, and the phase report's manual steps use it.
- Do not spawn subagents, parallel reviewers or multi-agent reviews unless the user explicitly asks for it. Do one careful self-check instead. The user watches usage limits.
