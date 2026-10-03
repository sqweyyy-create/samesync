# SameSync content format

This is the reference for writing SameSync's content files: the "hot takes" users swipe on, and the interest catalog they pick from. You can author valid files from this page alone, without reading any code.

- **Applies to:** schema version `1` as extended in Phase 1 (`revision`, `retiredIn`, `searchTerms`, dating options, `release.json`, `content.lock.json`) and Phase 2 (chat aliases are required). Checked against the repository on 2026-10-03.
- **What onboarding (Phase 1) uses:** sections 3 (takes), 4 (interest catalog) and 5 (dating options), plus the release and lockfile workflow in section 7.
- **What matching (Phase 2) uses:** the same takes and catalog (including `priorAgree` and `popularity`), and the chat aliases in section 6. Match teasers show take texts and item and category names, so see "How teasers use your text" in sections 3 and 4.
- Fields added in Phase 1 are optional with defaults, so files written before Phase 1 stay valid.

## 1. Basics

### Files and folders

Content lives in the `content/` folder of the repository.

| Folder or file | What it holds | Needed from |
|---|---|---|
| `content/questions/*.json` | Takes (agree/disagree statements) | Phase 1 |
| `content/interests/*.json` | Interest categories and items | Phase 1 |
| `content/dating/*.json` | Dating options ("You are" / "Looking for") | Phase 1 |
| `content/openers/*.json` | Pre-written first messages | Phase 3 |
| `content/aliases/*.json` | Anonymous chat names | Phase 2 |
| `content/products.json` | Telegram Stars products | Phase 6 |
| `content/release.json` | The release version of the whole content set (section 7) | Phase 1, **required** |
| `content/content.lock.json` | Generated: revision and text hash of every entry (section 7). Never edit it by hand | Phase 1, **required** |

How files are found:

- Every file ending in `.json` **directly inside** one of those folders is read, in alphabetical order of file name. `products.json`, `release.json` and `content.lock.json` are single files at the top of `content/`.
- A folder may hold any number of files. Split them by theme, for example `questions/food.json` and `questions/internet.json`. IDs must be unique across *all* files.
- File names aren't checked. Use lowercase letters, digits and `_`, for example `music_post_punk.json`.
- **Anything else is an error** (an allowlist): an unknown folder or file at the top of `content/` (`question/`, `README.md`), and a subfolder or non-`.json` file inside a content folder (`questions/old/`, `questions/notes.txt`).
- Not reported: hidden files whose name starts with `.` (such as `.DS_Store`), and the entries that belong to the `content/` code package itself (`src/`, `test/`, `node_modules/`, `package.json`, `tsconfig.json`).

### JSON rules

- UTF-8 **without a byte-order mark (BOM)**, standard JSON: no comments, no trailing commas. Some editors offer "UTF-8 with BOM"; a BOM makes the whole file "invalid JSON".
- Every file is one JSON object containing `"schemaVersion": 1` plus its list(s), as shown in the examples.
- Formatting (indentation, line breaks) is up to you: the repository's code formatter doesn't touch content files, and the checker only reads the values.
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
| Interest item | `i` | `i.music.molchat_doma` | **Enforced:** `i.<domain>.<slug>`, where `<domain>` is its category's domain |
| Opener | `o` | `o.pineapple_pizza.agree` | `o.<take slug>.<agree or disagree>` |
| Chat alias | `a` | `a.otter` | `a.<slug>` |
| Product | none (see above) | `test.extra_match` | `<group>.<name>` |
| Dating option (section 5) | `g` | `g.man` | `g.<slug>` |

### Rules

- **Unique across all content.** No two entries may share an ID, even in different files or of different kinds.
- **Permanent.** IDs are stored in the database: users' answers, their picked interests, their dating options, and the teaser and aliases of every match. So once an ID has been published:
  - never rename it;
  - never reuse it for something else, even after the entry is removed;
  - never change what it means. "Pineapple on pizza is fine" can't become "Pineapple on pizza is gross" under the same ID. Create a new ID and **retire** the old one with `retiredIn` (section 7).
- **Never delete an entry.** `content:check` fails if an ID that is in `content.lock.json` disappears. Retire it instead.
- **Typo fixes** keep the ID but need a `revision` bump (section 7).

### Fields every text entry can have

Every entry that has text (takes, categories, items, dating options, openers, aliases, products) accepts:

| Field | Type | Required | Rules |
|---|---|---|---|
| `revision` | integer ≥ 1 | no, default `1` | Increase it by 1 whenever you change any of the entry's texts (section 7) |

Takes, categories, items and dating options also accept:

| Field | Type | Required | Rules |
|---|---|---|---|
| `retiredIn` | string | no | The release version in which the entry was retired, e.g. `"2026.10.2"`. It must not be later than the version in `release.json`. Retired entries stay in the file, are hidden from new users, and nothing new may reference them |

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
| `modes` | list of modes | yes | Which decks it can appear in. If `audiences` includes `"u18"`, `modes` must include `"friends"` (u18 users never use dating) |
| `priorAgree` | number | yes | The share of people you expect to **agree**, strictly between `0` and `1` (e.g. `0.5`; `0` and `1` are rejected). It must be a JSON number, not a string. Use `0.5` if unsure |
| `text` | localized text | yes | The statement on the card, in every locale listed in `locales`. At most **120 characters** per locale |
| `revision`, `retiredIn` | | no | See section 2 |

**What `priorAgree` is for.** Matching weighs rare overlaps above common ones. A minority opinion that two people share counts for more than one almost everybody holds. Until a pool has enough real answers, `priorAgree` stands in for the real agree share. A take nearly everyone agrees with (`0.9`) makes a weak match signal; a split take (`0.5`) makes a good one.

**Writing good takes:**
- One clear, opinionated statement, not a question.
- Short enough for a phone card: aim for 90 characters or fewer (120 is the hard limit).
- Specific beats generic: "Голосовые длиннее минуты — преступление" works better than "Люблю общаться".
- No hate, sexual content, or questions about health or politics that identify a person. Content for `u18` gets an extra review.

**How teasers use your text (Phase 2).** When two matched users are on the same side of a take, the match teaser quotes the statement as it is: «Вы сходитесь во мнении: «Ананасы на пицце — это нормально» — вы за.» / "You see it the same way: “Pineapple on pizza is fine” — you both agree." So write a statement that still reads well inside quotation marks, with no final full stop.

**Deck sizes (Phase 1, decided in PLAN.md Q5).**
- Each user sees **35 takes**, drawn for their age band and mode. They can skip some but must answer at least 25.
- So the content must supply at least 35 active (not retired) takes for every one of these 6 combinations: `u18`+`friends`, `adult`+`friends` and `adult`+`dating`, each in `ru` and in `en`. One take can count toward several combinations.
- `pnpm content:check --launch` counts this (section 8).

**Leave these out for now:**
- Stance texts: Phase 3 adds short phrasings of each side, used in match teasers ("…also thinks …"). Don't add them yet; today they're rejected as unknown keys.
- Openers: they already exist as their own file type (section 6), but aren't needed before Phase 3.

### Example: a takes file

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
| `name` | localized text | yes | Display name, for example a genre ("Пост-панк" / "Post-punk"). At most **40 characters** |
| `revision`, `retiredIn` | | no | See section 2. Items can't stay active in a retired category |

Domains: `music` (artists, bands, genres), `games` (video and tabletop games), `shows` (TV series, anime, YouTube or streaming shows), `movies` (films, franchises), `books` (books, authors, comics, manga), `memes` (memes, internet culture). Adding a domain is a schema change, not a content change.

### Item fields

| Field | Type | Required | Allowed values and rules |
|---|---|---|---|
| `id` | string | yes | `i.<domain>.<slug>`, where `<domain>` is the category's `domain` (checked) |
| `categoryId` | string | yes | The `id` of an existing category, in any interests file |
| `popularity` | string | yes | `"mainstream"`, `"known"` or `"niche"`, see below. The field is `popularity`, not `popularity_prior` |
| `locales` | list of locales | yes | Must be a subset of the category's `locales`. Name required for each |
| `audiences` | list of audiences | yes | Must be a subset of the category's `audiences` |
| `name` | localized text | yes | Display name. For proper nouns it's fine to use the same spelling in both locales, or the Cyrillic form for `ru`. At most **40 characters** |
| `searchTerms` | object: locale → list of strings | no | Extra words the picker's search matches, never shown: other spellings, transliterations, nicknames (`{ "ru": ["молчат", "molchat"], "en": ["md"] }`). Only for locales in `locales`; up to 10 terms per locale, each at most 40 characters. The picker also matches the item's name and its category's name |
| `revision`, `retiredIn` | | no | See section 2 |

**`popularity` values.** Your best guess of how many people in a pool would pick the item. Matching uses it as the rarity prior until real picks exist (PLAN.md §5):

| Value | Meaning | Assumed share of a pool |
|---|---|---|
| `mainstream` | Almost everyone knows it; many will pick it (a global pop star, Minecraft) | ≈ 30% |
| `known` | Clear following, but far from universal (a cult indie game, a well-known indie band) | ≈ 8% |
| `niche` | Small, specific fandom; sharing it says a lot (a local underground band, an obscure meme) | ≈ 1% |

If unsure, use `known`. Overrating mainstream items as `niche` produces bad matches, so err towards `mainstream` for anything widely known.

**How teasers use your text (Phase 2).** A match teaser names what two users share: an item, or in broader matches a category. The name is put after a fixed phrase, unchanged: «У кого-то в плейлисте тоже Молчат Дома.», «У кого-то на книжной полке тоже Достоевский.», «Кто-то тоже любит такие игры: Инди-игры.» So keep every Russian name in its dictionary form (nominative), as in the examples, and don't add a full stop.

**Catalog size.** Launch-shaped content needs at least 150 active items across at least 4 domains **in each locale** (`content:check --launch`, section 8). The final launch size is still open (PLAN.md Q6).

### Example: an interests file

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
      "name": { "ru": "Молчат Дома", "en": "Molchat Doma" },
      "searchTerms": { "ru": ["молчат", "molchat"] }
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

## 5. Dating options (`content/dating/*.json`)

Dating mode (adults only) asks two things:
- **"You are"**: exactly one option.
- **"Looking for"**: one or more options.

Two users can match only if each one's "You are" is in the other's "Looking for" (PLAN.md Q11). The options live in content so the list can grow later without code changes. The questions themselves ("You are", "Looking for") are app UI text, not content.

File structure:

```json
{ "schemaVersion": 1, "genders": [ /* option objects */ ] }
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | Prefix `g.`; permanent, because it's stored in `users.gender` and `users.seeking` |
| `self` | localized text | yes, `ru` and `en` | Label in the "You are" list ("Мужчина" / "Man"). At most 40 characters |
| `seeking` | localized text | yes, `ru` and `en` | Label in the "Looking for" list. Russian uses the accusative plural that follows "Ищу": "мужчин", "женщин". At most 40 characters |
| `revision`, `retiredIn` | | no | See section 2 |

There must be at least two options that aren't retired. The decided list (Q11) is man / woman, looking for men / women:

<!-- content-example: dating/genders.json -->
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

## 6. Other file types

Chat aliases are used from Phase 2. Openers and products are already defined and checked, so files of these types must be valid today, but nothing uses them yet. Each entry also accepts `revision` (section 2).

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

### Chat aliases (`content/aliases/*.json`): used from Phase 2

Anonymous display names. Every match gives its two users two different aliases, for example "🦦 Выдра" and "🦊 Лиса": each of them sees the other under that name. The aliases are picked at random for each match, avoiding names a person already sees in their other open matches.

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | Prefix `a.`; permanent, because it's stored with every match |
| `emoji` | string | yes | 1–16 characters (counted in UTF-16 code units; one emoji is usually 2–8) |
| `text` | localized text | yes, `ru` and `en` | The name. Russian may use any gender. It names an animal, not the user. At most 40 characters |

- There must be **at least two** aliases. Launch-sized content needs **at least 12** (`content:check --launch`): a user can have 5 open matches at once, each under a different name.
- Aliases can't be retired or removed once published. To stop using a name, ask a developer.
- Pick friendly, neutral names. Avoid animals that read as an insult in either language.

The committed file has 32 aliases; the example shows three:

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

## 7. Releases, revisions and the lockfile

### `content/release.json`

Every content root declares one release version:

<!-- content-example: release.json -->
```json
{
  "schemaVersion": 1,
  "version": "2026.10.1"
}
```

- Format `YYYY.MM.N`: year, month (`01`–`12`), then a counter within the month, e.g. `2026.10.1`, `2026.10.2`, `2026.11.1`.
- **Bump it whenever the content changes** before it is seeded into a database. `pnpm content:seed` refuses to seed changed content under a version that was already seeded, and refuses a version older than one already seeded.
- `retiredIn` values must not be later than this version.

### Changing a text: `revision` and `content.lock.json`

`content.lock.json` is generated. For every entry with text it records the `revision` and a hash of all the entry's texts. Only texts count: changing `priorAgree`, `popularity`, `audiences` or `searchTerms` doesn't affect it. `pnpm content:check` compares the content with it.

To fix a typo or reword a text:
1. Edit the text **and** increase that entry's `revision` by 1 (add `"revision": 2` if the field isn't there yet).
2. Run `pnpm content:lock`. It rewrites `content.lock.json` and commits nothing itself.
3. Commit both files.

`content:check` fails if:
- a text changed but the `revision` didn't ("text changed without a revision bump");
- a `revision` went down;
- an ID that's in the lockfile disappeared (IDs are permanent: set `retiredIn` instead);
- the lockfile is missing or out of date (run `pnpm content:lock`).

`pnpm content:lock` refuses to write the lockfile while any of the first three problems exists, so it can't be used to hide them.

### Retiring an entry

Set `"retiredIn": "<current release version>"` on the entry and keep it in the file. Bump `release.json` if this release was already seeded. Users who already answered or picked it keep their data, but it's no longer offered.

## 8. What `pnpm content:check` validates

Run it from the repository root. It needs Node 24 and pnpm 12 (see `CLAUDE.md`). When everything is valid it prints one summary line (after pnpm's own command echo):

```
content:check OK (release 2026.10.2): 67 questions, 31 categories, 187 items, 2 dating options, 2 openers, 32 aliases, 1 products
```

Otherwise it exits with an error and prints one line per problem, named by file (for format errors) or by content ID (for cross-file errors):

```
content:check failed with 2 issue(s):
  - questions/core.json: questions.0.priorAgree: Too big: expected number to be <1
  - i.music.orphan: references unknown category c.music.does_not_exist
```

A format error rejects **the whole file**: none of its entries are loaded. Anything that refers to them then fails too. For example, if `questions/core.json` is rejected, openers pointing at its takes report "references unknown question". Fix format errors first, then re-run.

**It checks:**
1. Layout: only allowed folders and files (section 1).
2. Each file is valid JSON.
3. Each file matches its format: `schemaVersion` is `1`; every required field is present with the right type; values are from the allowed lists; lists are non-empty (where required) with no duplicates; IDs match the pattern for their kind; there are no unknown keys.
4. `release.json` exists and has a valid version; no `retiredIn` is later than it.
5. No ID is used twice across all files and kinds.
6. Every localized text has every required locale:
   - takes, categories and items: each locale in their `locales`;
   - openers: each locale of their take;
   - dating options, aliases and products: both `ru` and `en`.
7. References resolve:
   - every item's `categoryId` exists and isn't retired (unless the item is retired too);
   - an item's `locales` and `audiences` are within its category's;
   - every opener's `questionId` exists and isn't retired.
8. Consistency:
   - a take shown to `u18` includes `friends` mode;
   - an item ID uses its category's domain;
   - `searchTerms` only for the item's locales.
9. Length limits, counted in characters (an emoji counts as one):
   - take text ≤ 120;
   - category, item, dating-option and alias names ≤ 40;
   - search terms ≤ 40.
10. At least two dating options that aren't retired, and at least two chat aliases.
11. The lockfile: no text change without a revision bump, no lowered revision, no removed ID, and the lockfile is up to date.

**`pnpm content:check --launch`** runs all of the above and also checks that the content is big enough to launch, counting only entries that aren't retired:
- ≥ 35 takes for each deck: `u18`+`friends`, `adult`+`friends` and `adult`+`dating`, each in `ru` and `en`;
- ≥ 150 items across ≥ 4 domains in each locale;
- ≥ 12 chat aliases.

The small test fixtures only need to pass the normal check; the committed content must pass both.

**It does not check:** whether text is accurate, age-appropriate, well written or gender-neutral. That's editorial review.

Phase 3 will add stance texts on takes and require openers (or a generic fallback) for every take.
