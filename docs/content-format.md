# SameSync content format

This is the reference for writing SameSync's content files: the "hot takes" users swipe on, and the interest catalog they pick from. You can author valid files from this page alone, without reading any code.

- **Applies to:** schema version `1`, the format `pnpm content:check` accepts today. Checked against the repository on 2026-10-03.
- **What Phase 1 needs:** sections 3 (takes) and 4 (interest catalog). Phase 1 also needs section 5 (dating options): its option list is decided (PLAN.md Q11), but its file format is still a proposal that the checker doesn't read until the section 8 change lands.
- **Not final yet:** some fields Phase 1 needs aren't accepted by the checker yet. Section 8 lists them. Until those changes land, author exactly as the examples show; anything extra makes the check fail.

## 1. Basics

### Files and folders

Content lives in the `content/` folder of the repository.

| Folder or file | What it holds | Needed from |
|---|---|---|
| `content/questions/*.json` | Takes (agree/disagree statements) | Phase 1 |
| `content/interests/*.json` | Interest categories and items | Phase 1 |
| `content/dating/*.json` | Dating options ("You are" / "Looking for"). **Not read yet**, see section 5 | Phase 1 (after the schema change) |
| `content/openers/*.json` | Pre-written first messages | Phase 3 |
| `content/aliases/*.json` | Anonymous chat names | Phase 2 |
| `content/products.json` | Telegram Stars products | Phase 6 |

How files are found:

- Every file ending in `.json` **directly inside** one of those folders is read, in alphabetical order of file name. `products.json` is a single file at the top of `content/`.
- A folder may hold any number of files. Split them by theme, for example `questions/food.json` and `questions/internet.json`. IDs must be unique across *all* files.
- File names aren't checked. Use lowercase letters, digits and `_`, for example `music_post_punk.json`.
- ⚠ Anything else is **silently ignored**: subfolders (`questions/old/x.json`), other extensions (`.txt`, `.json5`) and misspelled folder names (`question/`). If your file doesn't show up in the `content:check` totals, check its location.

### JSON rules

- UTF-8 **without a byte-order mark (BOM)**, standard JSON: no comments, no trailing commas. Some editors offer "UTF-8 with BOM"; a BOM makes the whole file "invalid JSON".
- Every file is one JSON object containing `"schemaVersion": 1` plus its list(s), as shown in the examples.
- **Unknown keys are errors** everywhere: at the top of a file, on every entry and inside text objects. Field names are case-sensitive and exactly as written here, for example `priorAgree`, not `prior_agree`.

### Shared value types

| Type | Allowed values | Notes |
|---|---|---|
| Locale | `"ru"`, `"en"` | Russian is the main locale |
| Audience (age band) | `"u18"`, `"adult"` | `u18` = users aged 14–17, `adult` = 18+. The two never see each other |
| Mode | `"friends"`, `"dating"` | `u18` users only ever use `friends` |
| List of locales / audiences / modes | JSON array of the values above | At least one value, no duplicates, any order |
| Localized text | Object whose keys are locales and whose values are strings | See below |

**Localized text**, for example `{ "ru": "Пост-панк", "en": "Post-punk" }`:

- Allowed keys are only `ru` and `en`. Any other key (`"de"`) is an error.
- Each value must contain at least one non-space character. Leading and trailing spaces are ignored.
- Which keys are **required** depends on the entry: usually every locale in the entry's `locales` list, as stated per field below. A text for a locale that isn't in `locales` is allowed but never shown.
- Russian text that addresses or quotes the user must be **gender-neutral**, because we don't know the user's gender. Avoid past-tense verbs and short adjectives with a gender ending ("я думал", "ты готова"). Prefer impersonal statements and present tense.

## 2. IDs

Every entry has an `id`, for example `q.pineapple_pizza` or `i.music.molchat_doma`.

### Format

- `<prefix>.<segment>`, optionally followed by more `.<segment>` parts.
- A segment uses only **lowercase Latin letters `a–z`, digits `0–9` and `_`**: no capitals, hyphens, spaces or Cyrillic. Transliterate names, for example `molchat_doma`.
- Exact pattern: `^<prefix>\.[a-z0-9_]+(\.[a-z0-9_]+)*$`.
- Products are the exception: they have no fixed prefix and use `^[a-z0-9_]+(\.[a-z0-9_]+)+$`. At least two segments are **enforced**.

| Kind | Prefix | Example | Recommended shape (not enforced) |
|---|---|---|---|
| Take | `q` | `q.pineapple_pizza` | `q.<slug>` or `q.<topic>.<slug>` |
| Interest category | `c` | `c.music.post_punk` | `c.<domain>.<slug>` |
| Interest item | `i` | `i.music.molchat_doma` | `i.<domain>.<slug>`, using its category's domain |
| Opener | `o` | `o.pineapple_pizza.agree` | `o.<take slug>.<agree or disagree>` |
| Chat alias | `a` | `a.otter` | `a.<slug>` |
| Product | none (see above) | `test.extra_match` | `<group>.<name>` |
| Dating option (section 5) | `g` | `g.man` | `g.<slug>` (proposed) |

### Rules

- **Unique across all content.** No two entries may share an ID, even in different files or of different kinds.
- **Permanent.** IDs are stored in the database: users' answers, their picked interests, their dating options. So once an ID has been published:
  - never rename it;
  - never reuse it for something else, even after the entry is removed;
  - never change what it means. "Pineapple on pizza is fine" can't become "Pineapple on pizza is gross" under the same ID. Create a new ID instead; Phase 1 adds a way to retire the old one (section 8).
- **Typo fixes** keep the ID. From Phase 1 they will also need a `revision` bump (section 8).
- Treat IDs as permanent from the first commit, even though nothing is seeded into a database yet.

## 3. Takes (`content/questions/*.json`)

A take is a short statement users swipe *agree* or *disagree* on. The takes users answer are the core of their profile and of matching.

File structure:

```json
{ "schemaVersion": 1, "questions": [ /* take objects */ ] }
```

(The comment only marks where the entries go; real files can't contain comments.)

### Take fields

| Field | Type | Required | Allowed values and rules |
|---|---|---|---|
| `id` | string | yes | Prefix `q.`; see section 2 |
| `locales` | list of locales | yes | Which language pools see this take. Text is required for each of them |
| `audiences` | list of audiences | yes | Which age bands see it. Anything including `"u18"` must suit 14–17-year-olds |
| `modes` | list of modes | yes | Which decks it can appear in. A take meant for `u18` must include `"friends"` (u18 users never use dating; not checked yet) |
| `priorAgree` | number | yes | The share of people you expect to **agree**, strictly between `0` and `1` (e.g. `0.5`; `0` and `1` are rejected). It must be a JSON number, not a string. Use `0.5` if unsure |
| `text` | localized text | yes | The statement on the card, in every locale listed in `locales` |

**What `priorAgree` is for.** Matching weighs rare overlaps above common ones. A minority opinion that two people share counts for more than one almost everybody holds. Until a pool has enough real answers, `priorAgree` stands in for the real agree share. A take nearly everyone agrees with (`0.9`) makes a weak match signal; a split take (`0.5`) makes a good one.

**Writing good takes:**
- One clear, opinionated statement, not a question.
- Short enough for a phone card: aim for 90 characters or fewer (not enforced yet).
- Specific beats generic: "Голосовые длиннее минуты — преступление" works better than "Люблю общаться".
- No hate, sexual content, or questions about health or politics that identify a person. Content for `u18` gets an extra review.

**Deck sizes (Phase 1, decided in PLAN.md Q5).**
- Each user sees **35 takes**, drawn for their age band and mode. They can skip some but must answer at least 25.
- So the content must supply at least 35 takes for every one of these 6 combinations: `u18`+`friends`, `adult`+`friends` and `adult`+`dating`, each in `ru` and in `en`. One take can count toward several combinations.
- `content:check` doesn't count this yet (section 8).

**Leave these out for now:**
- `revision`: Phase 1 adds it (section 8). Today it's rejected as an unknown key.
- Stance texts: Phase 3 adds short phrasings of each side, used in match teasers ("…also thinks …"). Don't add them yet.
- Openers: they already exist as their own file type (section 6), but aren't needed before Phase 3.

### Example: `content/questions/core.json`

<!-- content-example: questions/core.json -->
```json
{
  "schemaVersion": 1,
  "questions": [
    {
      "id": "q.pineapple_pizza",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "modes": ["friends", "dating"],
      "priorAgree": 0.5,
      "text": { "ru": "Ананасы на пицце — это нормально", "en": "Pineapple on pizza is fine" }
    },
    {
      "id": "q.long_voice_messages",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "modes": ["friends", "dating"],
      "priorAgree": 0.6,
      "text": {
        "ru": "Голосовые длиннее минуты — преступление",
        "en": "Voice messages over a minute long are a crime"
      }
    },
    {
      "id": "q.remakes_worse",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "modes": ["friends", "dating"],
      "priorAgree": 0.7,
      "text": {
        "ru": "Ремейки почти всегда хуже оригинала",
        "en": "Remakes are almost always worse than the original"
      }
    }
  ]
}
```

## 4. Interest catalog (`content/interests/*.json`)

Users pick 5–30 **items** from the catalog: specific artists, games, shows, memes and so on (PLAN.md Q6, decided). Free-text entries aren't allowed. Each item belongs to a **category**, and each category belongs to a fixed **domain**. When there aren't enough exact matches, matching falls back to shared categories and then to shared domains.

File structure. Both lists are required in every interests file, but either may be empty:

```json
{ "schemaVersion": 1, "categories": [ /* category objects */ ], "items": [ /* item objects */ ] }
```

An item may refer to a category defined in another interests file.

### Category fields

| Field | Type | Required | Allowed values and rules |
|---|---|---|---|
| `id` | string | yes | Prefix `c.`; recommended `c.<domain>.<slug>` |
| `domain` | string | yes | One of `"music"`, `"games"`, `"shows"`, `"movies"`, `"books"`, `"memes"` |
| `locales` | list of locales | yes | Language pools where the category exists. Name required for each |
| `audiences` | list of audiences | yes | Age bands that can see it |
| `name` | localized text | yes | Display name, for example a genre ("Пост-панк" / "Post-punk") |

Domains: `music` (artists, bands, genres), `games` (video and tabletop games), `shows` (TV series, anime, YouTube or streaming shows), `movies` (films, franchises), `books` (books, authors, comics, manga), `memes` (memes, internet culture). Adding a domain is a schema change, not a content change.

### Item fields

| Field | Type | Required | Allowed values and rules |
|---|---|---|---|
| `id` | string | yes | Prefix `i.`; recommended `i.<domain>.<slug>` using the category's domain (not checked) |
| `categoryId` | string | yes | The `id` of an existing category, in any interests file |
| `popularity` | string | yes | `"mainstream"`, `"known"` or `"niche"`, see below. The field is `popularity`, not `popularity_prior` |
| `locales` | list of locales | yes | Must be a subset of the category's `locales`. Name required for each |
| `audiences` | list of audiences | yes | Must be a subset of the category's `audiences` |
| `name` | localized text | yes | Display name. For proper nouns it's fine to use the same spelling in both locales, or the Cyrillic form for `ru` |

**`popularity` values.** Your best guess of how many people in a pool would pick the item. Matching uses it as the rarity prior until real picks exist (PLAN.md §5):

| Value | Meaning | Assumed share of a pool |
|---|---|---|
| `mainstream` | Almost everyone knows it; many will pick it (a global pop star, Minecraft) | ≈ 30% |
| `known` | Clear following, but far from universal (a cult indie game, a well-known indie band) | ≈ 8% |
| `niche` | Small, specific fandom; sharing it says a lot (a local underground band, an obscure meme) | ≈ 1% |

If unsure, use `known`. Overrating mainstream items as `niche` produces bad matches, so err towards `mainstream` for anything widely known.

**Not supported yet:**
- **Search aliases.** Alternative spellings or names for search ("молчат дома", "MD") are planned for Phase 1 as `searchTerms` (section 8). Today that key is rejected.
- **Catalog size.** Phase 1 needs at least 150 items across at least 4 domains. The launch size is still open (PLAN.md Q6). `content:check` doesn't count this yet.

### Example: `content/interests/catalog.json`

<!-- content-example: interests/catalog.json -->
```json
{
  "schemaVersion": 1,
  "categories": [
    {
      "id": "c.music.post_punk",
      "domain": "music",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "name": { "ru": "Пост-панк", "en": "Post-punk" }
    },
    {
      "id": "c.games.indie",
      "domain": "games",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "name": { "ru": "Инди-игры", "en": "Indie games" }
    }
  ],
  "items": [
    {
      "id": "i.music.molchat_doma",
      "categoryId": "c.music.post_punk",
      "popularity": "known",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "name": { "ru": "Молчат Дома", "en": "Molchat Doma" }
    },
    {
      "id": "i.music.joy_division",
      "categoryId": "c.music.post_punk",
      "popularity": "mainstream",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "name": { "ru": "Joy Division", "en": "Joy Division" }
    },
    {
      "id": "i.games.hollow_knight",
      "categoryId": "c.games.indie",
      "popularity": "known",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "name": { "ru": "Hollow Knight", "en": "Hollow Knight" }
    },
    {
      "id": "i.games.celeste",
      "categoryId": "c.games.indie",
      "popularity": "known",
      "locales": ["ru", "en"],
      "audiences": ["u18", "adult"],
      "name": { "ru": "Celeste", "en": "Celeste" }
    }
  ]
}
```

## 5. Dating options (`content/dating/genders.json`): decided, not yet read

> ⚠ **Status:** the content of this list is a product-owner decision (PLAN.md Q11). The file format below is the proposal for Phase 1. **`content:check` does not read `content/dating/` yet; such a file is silently ignored.** Section 8, item 5 lists the schema change that makes it real.

Dating mode (adults only) asks two things:
- **"You are"**: exactly one option.
- **"Looking for"**: one or more options.

Two users can match only if each one's "You are" is in the other's "Looking for". The options live in content so the list can grow later without code changes. The questions themselves ("You are", "Looking for") are app UI text, not content.

Proposed fields for each option:

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | Prefix `g.`; permanent, because it's stored in `users.gender` and `users.seeking` |
| `self` | localized text | yes, all locales | Label in the "You are" list ("Мужчина" / "Man") |
| `seeking` | localized text | yes, all locales | Label in the "Looking for" list. Russian uses the accusative plural that follows "Ищу": "мужчин", "женщин" |

The decided option list is: man / woman, looking for men / women.

<!-- content-proposed: dating/genders.json -->
```json
{
  "schemaVersion": 1,
  "genders": [
    {
      "id": "g.man",
      "self": { "ru": "Мужчина", "en": "Man" },
      "seeking": { "ru": "Мужчин", "en": "Men" }
    },
    {
      "id": "g.woman",
      "self": { "ru": "Женщина", "en": "Woman" },
      "seeking": { "ru": "Женщин", "en": "Women" }
    }
  ]
}
```

## 6. Other file types (not needed for Phase 1)

These are already defined and checked, so files of these types must be valid today, but Phase 1 doesn't use them.

### Openers (`content/openers/*.json`): Phase 3

The pre-written first message suggested after the game, written from the sender's side of a take they disagreed on.

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | Prefix `o.` |
| `questionId` | string | yes | `id` of an existing take |
| `side` | string | yes | `"agree"` or `"disagree"`: the side of the person **sending** the message |
| `text` | localized text | yes | In every locale of the referenced take. Gender-neutral Russian (it's sent in the user's name) |

<!-- content-example: openers/core.json -->
```json
{
  "schemaVersion": 1,
  "openers": [
    {
      "id": "o.pineapple_pizza.agree",
      "questionId": "q.pineapple_pizza",
      "side": "agree",
      "text": {
        "ru": "Я за ананасы на пицце. Что с ними не так?",
        "en": "I'm pro-pineapple on pizza. What's wrong with it?"
      }
    },
    {
      "id": "o.pineapple_pizza.disagree",
      "questionId": "q.pineapple_pizza",
      "side": "disagree",
      "text": {
        "ru": "Ананасам на пицце не место. Чем они тебе нравятся?",
        "en": "Pineapple doesn't belong on pizza. What do you like about it?"
      }
    }
  ]
}
```

### Chat aliases (`content/aliases/*.json`): Phase 2

Anonymous display names in chats.

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | Prefix `a.` |
| `emoji` | string | yes | 1–16 characters (counted in UTF-16 code units; one emoji is usually 2–8) |
| `text` | localized text | yes, `ru` and `en` | The name. Russian may use any gender. It names an animal, not the user |

<!-- content-example: aliases/animals.json -->
```json
{
  "schemaVersion": 1,
  "aliases": [
    { "id": "a.otter", "emoji": "🦦", "text": { "ru": "Выдра", "en": "Otter" } },
    { "id": "a.fox", "emoji": "🦊", "text": { "ru": "Лиса", "en": "Fox" } },
    { "id": "a.owl", "emoji": "🦉", "text": { "ru": "Сова", "en": "Owl" } }
  ]
}
```

### Products (`content/products.json`): Phase 6

Telegram Stars products. Paid features are undecided (PLAN.md Q27); the only entry is a disabled placeholder.

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | Two or more segments, e.g. `test.extra_match` |
| `stars` | integer | yes | Price in Telegram Stars, ≥ 1 |
| `enabled` | boolean | yes | `false` hides the product |
| `bandsAllowed` | list of audiences | yes | Who may buy it. May be empty; no duplicates |
| `grants` | list of `{ "kind": non-empty string, "amount": integer ≥ 1 }` | yes | At least one; no other keys |
| `title`, `description` | localized text | yes, `ru` and `en` | Shown on the invoice |

<!-- content-example: products.json -->
```json
{
  "schemaVersion": 1,
  "products": [
    {
      "id": "test.extra_match",
      "stars": 1,
      "enabled": false,
      "bandsAllowed": ["adult"],
      "grants": [{ "kind": "extra_match", "amount": 1 }],
      "title": { "ru": "Ещё одно знакомство", "en": "One more match" },
      "description": {
        "ru": "Тестовый товар для проверки оплаты",
        "en": "Placeholder product for testing payments"
      }
    }
  ]
}
```

## 7. What `pnpm content:check` validates

Run it from the repository root. It needs Node 24 and pnpm 12 (see `CLAUDE.md`). It prints one summary line when everything is valid:

```
content:check OK: 3 questions, 2 categories, 4 items, 2 openers, 3 aliases, 1 products
```

Otherwise it exits with an error and prints one line per problem, named by file (for format errors) or by content ID (for cross-file errors):

```
content:check failed with 2 issue(s):
  - questions/core.json: questions.0.priorAgree: Too big: expected number to be <1
  - i.music.orphan: references unknown category c.music.does_not_exist
```

A format error rejects **the whole file**: none of its entries are loaded. Anything that refers to them then fails too. For example, if `questions/core.json` is rejected, openers pointing at its takes report "references unknown question". Fix format errors first, then re-run.

**It checks:**
1. Each file is valid JSON.
2. Each file matches its format: `schemaVersion` is `1`; every required field is present with the right type; values are from the allowed lists; lists are non-empty (where required) with no duplicates; IDs match the pattern for their kind; there are no unknown keys.
3. No ID is used twice across all files and kinds.
4. Every localized text has every required locale:
   - takes, categories and items: each locale in their `locales`;
   - openers: each locale of their take;
   - aliases and products: both `ru` and `en`.
5. References resolve:
   - every item's `categoryId` exists;
   - an item's `locales` and `audiences` are within its category's;
   - every opener's `questionId` exists.

**It does not check (yet):**
- whether text is accurate, age-appropriate, well written or gender-neutral (that's editorial review);
- deck and catalog sizes;
- that `u18` takes include `friends`;
- that an item's ID domain matches its category's domain;
- text length;
- files in the wrong place, which are ignored;
- typo fixes without a revision bump (that's the Phase 1 lockfile).

## 8. Schema changes needed in Phase 1

The current schema (version 1) is missing these for Phase 1. Each change should keep files written to this document valid, which is why new fields are proposed as optional with defaults. This document is updated in the same change.

1. **`revision`** (integer ≥ 1, optional, default `1`) on every entry that has text: takes, categories, items, openers, aliases, products and dating options. Together with `content/content.lock.json` (a hash of every text per ID), `content:check` will fail when a text changes without a `revision` bump (PLAN.md Phase 1). Today `revision` is rejected as an unknown key.
2. **Release identity.** Seeding records a content release (`content_releases.version` and `checksum`, PLAN.md §4). The version should be **declared by authors**, for example in `content/release.json` as `{ "schemaVersion": 1, "version": "2026.10.1" }`. The seeder computes the checksum separately. A checksum can't serve as the version, because the files that carry retirement markers would be part of what it hashes.
3. **Retirement.** A field `retiredIn` (a version declared in `release.json`, no later than the current one) on takes, categories, items and dating options. Seeded IDs are referenced by user data and must never be deleted. Retired entries stay in the files, are hidden from new users, and can't be referenced by new entries.
4. **Search terms for items:** `searchTerms: { "ru": [...], "en": [...] }`, optional per locale, used by the interest picker's search. It's named `searchTerms` to avoid confusion with chat aliases.
5. **Dating options (Q11):** read `content/dating/*.json` in the format of section 5. Check:
   - IDs are unique with prefix `g.`;
   - `self` and `seeking` exist in both locales;
   - at least two options.

   Users' stored `gender` / `seeking` values must reference these IDs.
6. **Fail on unexpected content files.** `content/` is also a code package (`src/`, `test/`, `node_modules/`, `package.json`, `tsconfig.json`), so use an allowlist:
   - the content folders (`questions/`, `interests/`, `openers/`, `aliases/`, `dating/`) and the known root files (`products.json`, `release.json`, `content.lock.json`) are content;
   - inside a content folder, any subfolder or file that isn't `*.json` is an error;
   - the package files are ignored.

   That way a misplaced content file can't silently disappear.
7. **Consistency checks:**
   - a take whose `audiences` include `u18` must include `friends` in `modes`;
   - optionally, an item ID's domain segment must equal its category's `domain`.
8. **Coverage minimums for launch-shaped content:**
   - ≥ 35 takes for each band × mode × locale combination (section 3);
   - ≥ 150 items across ≥ 4 domains.

   Make this a separate mode (e.g. `content:check --launch`) or a warning, because the small sample content must still pass the normal check.
9. **Optional length limits:** for example take text ≤ 120 characters and item or category names ≤ 40, so they fit on cards and chips.

Phase 3 (not Phase 1) will add stance texts on takes and require openers (or a generic fallback) for every take.
