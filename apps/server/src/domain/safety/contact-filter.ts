/**
 * The under-18 contact filter (PLAN.md Phase 5; CLAUDE.md invariant 5). Pure: a text goes in, and
 * the kind of contact found in it comes out, or null. It looks for usernames (`@name`, bare
 * handles next to the name of a social network), phone numbers (including spaced, dotted and
 * written-out digits), links and domains (including "t me", "точка ру", "собака"), e-mail
 * addresses, and handles of social networks, through the disguises PLAN.md lists: Unicode
 * compatibility forms, letter case, Cyrillic and Latin look-alikes, spaced-out characters,
 * number words, and "at" and "dot" written as words.
 *
 * The relay runs it on the message and on a window of the sender's last messages in that chat,
 * so a contact split across messages is caught too (services/contact-filter.ts). A hit means the
 * message is not delivered; so does an error (the screening hook fails closed). Every evasion
 * found in production goes into the corpus of apps/server/test/fixtures/contact-filter/.
 *
 * Reading guide: `normalize` builds three views of the text (original script, Latin look-alikes,
 * Cyrillic look-alikes), and each detector looks at the view it needs.
 */
export type ContactKind = 'url' | 'handle' | 'phone' | 'email' | 'social';

export interface ContactHit {
  kind: ContactKind;
}

/** Zero-width and other invisible characters used to break up a word. */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u2060-\u2064\ufeff]/gu;
/** Combining marks left after NFKC: strike-through and underline "fonts". */
const COMBINING = /\p{Mn}/gu;

/** Cyrillic and Greek letters that look like Latin ones, and the Latin letters they pass for. */
const TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  к: 'k',
  м: 'm',
  т: 't',
  н: 'h',
  в: 'b',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  һ: 'h',
  ӏ: 'l',
  ө: 'o',
  ү: 'y',
  α: 'a',
  ε: 'e',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  ν: 'v',
  ι: 'i',
  κ: 'k',
  χ: 'x',
};
/** Latin letters that pass for Cyrillic ones. */
const TO_CYRILLIC: Readonly<Record<string, string>> = {
  a: 'а',
  e: 'е',
  o: 'о',
  p: 'р',
  c: 'с',
  y: 'у',
  x: 'х',
  k: 'к',
  m: 'м',
  t: 'т',
  h: 'н',
  b: 'в',
};

const mapChars = (text: string, map: Readonly<Record<string, string>>) =>
  text.replace(/[\p{L}]/gu, (ch) => map[ch] ?? ch);

/** The words people use for "@" and "." when they spell a contact out. */
const AT_WORDS =
  /\s*(?:\(\s*at\s*\)|\[\s*at\s*\]|\{\s*at\s*\}|(?<![\p{L}\p{N}])(?:собака|собачка|sobaka)(?![\p{L}\p{N}]))\s*/giu;
const DOT_WORDS =
  /\s*(?:\(\s*dot\s*\)|\[\s*dot\s*\]|\{\s*dot\s*\}|(?<![\p{L}\p{N}])(?:dot|точка|точку|точкой|tochka|дот)(?![\p{L}\p{N}]))\s*/giu;

/** Words that stand for digits when a number is dictated (ru and en). */
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  ноль: '0',
  нуль: '0',
  один: '1',
  одна: '1',
  одно: '1',
  раз: '1',
  два: '2',
  две: '2',
  три: '3',
  четыре: '4',
  пять: '5',
  шесть: '6',
  семь: '7',
  восемь: '8',
  девять: '9',
  десять: '10',
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};
const NUMBER_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${Object.keys(NUMBER_WORDS).join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
);

/**
 * Joins characters that were spaced out to hide a word: "i v a n _ 0 8" → "ivan_08",
 * "@ i v a n" → "@ivan", "t . m e" → "t.me". Three or more single characters in a row.
 */
export function collapseSpaced(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{N}@_.])(?:[\p{L}\p{N}@_.][ \-*·/|]{1,3}){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu,
    (run) => run.replace(/[ \-*·/|]/g, ''),
  );
}

export interface NormalizedText {
  /** Lower-case, no invisible characters, "at" and "dot" words replaced. Original scripts. */
  plain: string;
  /** `plain` with Cyrillic and Greek look-alikes turned into Latin letters. */
  latin: string;
  /** `plain` with Latin look-alikes turned into Cyrillic letters. */
  cyrillic: string;
  /** Spaced-out characters joined, in each of the three views. */
  collapsed: { plain: string; latin: string; cyrillic: string };
}

export function normalize(text: string): NormalizedText {
  const plain = text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(COMBINING, '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(AT_WORDS, ' @ ')
    .replace(DOT_WORDS, '.');
  const latin = mapChars(plain, TO_LATIN);
  const cyrillic = mapChars(plain, TO_CYRILLIC);
  return {
    plain,
    latin,
    cyrillic,
    collapsed: {
      plain: collapseSpaced(plain),
      latin: collapseSpaced(latin),
      cyrillic: collapseSpaced(cyrillic),
    },
  };
}

// --- e-mail -------------------------------------------------------------------------------------

const EMAIL =
  /(?<![\p{L}\p{N}])[a-z0-9][a-z0-9._+-]{0,63}(?:@\s?|\s@\s|\sat\s)[a-z0-9][a-z0-9-]{0,62}(?:\s?\.\s?[a-z0-9-]+)*\s?\.\s?[a-z]{2,}(?![\p{L}])/u;

// --- links and domains --------------------------------------------------------------------------

/** Domain endings that are never a word of a sentence: allowed even with spaces around the dot. */
const STRICT_TLDS = ['com', 'net', 'org', 'ru', 'su', 'io', 'gg', 'cc', 'xyz', 'info', 'biz'];
/** Endings that are also words ("me", "tv"): only with the dot written as in a real address. */
const LOOSE_TLDS = [
  'me',
  'co',
  'app',
  'dev',
  'page',
  'site',
  'online',
  'link',
  'club',
  'chat',
  'pro',
  'store',
  'shop',
  'fun',
  'top',
  'vip',
  'one',
  'cloud',
  'email',
  'lol',
  'ly',
  'tv',
  'us',
  'uk',
  'de',
  'ua',
  'kz',
  'by',
  'life',
  'live',
  'games',
  'zone',
  'space',
  'world',
  'media',
  'art',
  'blog',
  'fm',
  'to',
  'ws',
  'ee',
  'pl',
  'cz',
  'fi',
  'tk',
  'ml',
  'ga',
  'cf',
  'kr',
  'jp',
  'fr',
  'es',
  'nl',
  'se',
  'ch',
  'eu',
  'asia',
  'run',
  'win',
  'mobi',
  'name',
  'host',
  'tech',
  'icu',
  'team',
  'click',
  'download',
  'stream',
  'bar',
  'cafe',
  'dog',
  'social',
  'network',
  'love',
  'date',
  'dating',
  'pics',
  'photo',
  'video',
  'chat',
  'cam',
  'bot',
  'tube',
  'wiki',
  'ninja',
  'guru',
  'city',
  'moscow',
  'spb',
  'am',
  'az',
  'ge',
  'kg',
  'md',
  'tj',
  'tm',
  'uz',
  'lv',
  'lt',
  'rs',
  'bg',
  'ro',
  'hu',
  'sk',
  'si',
  'hr',
  'gr',
  'tr',
  'il',
  'ae',
  'in',
  'id',
  'vn',
  'th',
  'ph',
  'my',
  'sg',
  'au',
  'nz',
  'ca',
  'mx',
  'br',
  'ar',
  'cl',
  'pe',
  'it',
  'pt',
  'be',
  'dk',
  'ie',
  'is',
  'lu',
  'at',
  'li',
];
/** Cyrillic endings. */
const CYRILLIC_TLDS = [
  'ру',
  'рф',
  'ком',
  'нет',
  'орг',
  'су',
  'сайт',
  'онлайн',
  'москва',
  'дети',
  'бел',
  'укр',
];

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_STRICT = new RegExp(
  `(?<![\\p{L}\\p{N}@.-])${LABEL}(?:\\s?\\.\\s?${LABEL})*\\s?\\.\\s?(?:${STRICT_TLDS.join('|')})(?![\\p{L}\\p{N}-])`,
  'u',
);
const DOMAIN_LOOSE = new RegExp(
  `(?<![\\p{L}\\p{N}@.-])${LABEL}(?:\\.${LABEL})*\\.(?:${LOOSE_TLDS.join('|')})(?![\\p{L}\\p{N}-])`,
  'u',
);
const CYRILLIC_LABEL = '[a-zа-я0-9](?:[a-zа-я0-9-]{0,61}[a-zа-я0-9])?';
const DOMAIN_CYRILLIC = new RegExp(
  `(?<![\\p{L}\\p{N}@.-])${CYRILLIC_LABEL}(?:\\s?\\.\\s?${CYRILLIC_LABEL})*\\s?\\.\\s?(?:${CYRILLIC_TLDS.join('|')})(?![\\p{L}\\p{N}-])`,
  'u',
);
/** Schemes and the Telegram link forms, however the dot is written. */
const URL_FORMS =
  /(?:https?:\/\/|www\s?\.\s?[a-z0-9]|tg:\/\/|(?<![\p{L}\p{N}])t\s*\.\s*me(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])t\s+me(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])tme(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])telegram\s?\.\s?(?:me|dog|org)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])tlgrm\s?\.\s?ru(?![\p{L}\p{N}]))/u;

// --- phone numbers ------------------------------------------------------------------------------

/** Dates and times are not phone numbers, however many digits they add up to. */
const DATE_OR_TIME =
  /(?<![\d.])\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![\d.])|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g;
/** A long decimal fraction is a number, not a group of a phone number. */
const LONG_DECIMAL = /(?<!\d)\d+\.\d{5,}(?!\d)/g;
/** A letter "o" (either script) standing in for a zero between digits. */
const O_FOR_ZERO = /(?<=\d)[oо]+(?=\d)/g;
/** Characters that may sit between the digit groups of one number. */
const PHONE_SEPARATOR = /[\s().+,\-\u2010-\u2015\u2212]/;
const MIN_PHONE_DIGITS = 9;

/** The longest run of digits with only phone separators between them. */
export function longestDigitRun(text: string): number {
  const prepared = text
    .replace(NUMBER_WORD, (word) => NUMBER_WORDS[word]!)
    .replace(DATE_OR_TIME, ' ')
    .replace(LONG_DECIMAL, ' ');
  let longest = 0;
  let current = 0;
  for (const ch of prepared.replace(O_FOR_ZERO, (m) => '0'.repeat(m.length))) {
    if (/\d/.test(ch)) current++;
    else if (!PHONE_SEPARATOR.test(ch)) current = 0;
    if (current > longest) longest = current;
  }
  return longest;
}

// --- handles ------------------------------------------------------------------------------------

/** "@name": at least four characters, one of them a letter, in any script. */
const AT_HANDLE = /@(?=[\p{L}\p{N}_.]{4,})(?=[\p{L}\p{N}_.]*\p{L})[\p{L}\p{N}_.]+/u;
/** "@ name" with a space: only a name that could not be a word (a digit, "_" or "." in it). */
const AT_SPACED_HANDLE =
  /@ (?=[\p{L}\p{N}_.]{5,}(?![\p{L}\p{N}_.]))(?=[\p{L}\p{N}_.]*[\p{N}_.])[\p{L}\p{N}_.]+/u;
/** Discord tags and VK numeric IDs. */
const DISCORD_TAG = /(?<![a-z0-9_.])[a-z0-9_.]{2,32}#\d{4}(?!\d)/;
const VK_ID = /(?<![a-z0-9])id\d{5,}(?!\d)/;

// --- social networks ----------------------------------------------------------------------------

/** Names of networks and of handles, and the verbs that go with one, in both languages. */
const RU_KEYWORDS =
  /^(?:инст[а-я]{0,6}|телег[а-я]{0,5}|тг|тгшк[а-я]{0,2}|вк|вконтакте|дискорд[а-я]{0,2}|дс|снап(?:чат)?[а-я]{0,2}|тикток[а-я]{0,2}|тт|ватсап[а-я]{0,2}|вацап[а-я]{0,2}|воцап[а-я]{0,2}|вайбер[а-я]{0,2}|скайп[а-я]{0,2}|твиттер[а-я]{0,2}|твич[а-я]{0,2}|стим[а-я]{0,2}|ютуб[а-я]{0,2}|фейсбук[а-я]{0,2}|фб|ник(?:нейм)?[а-я]{0,3}|юзернейм[а-я]{0,2}|логин[а-я]{0,2}|лайки|пиши|напиши|добавь|добавляй|найди|ищи|скинь|кидай|зови)$/u;
const EN_KEYWORDS =
  /^(?:insta|instagram|ig|tg|telegram|vk|discord|snap|snapchat|tiktok|whatsapp|viber|skype|twitter|twitch|steam|youtube|facebook|fb|nick|nickname|username|handle|login|hmu|dm|add|find|follow)$/;

/** A token that looks like a handle rather than a word: letters with a digit, "_" or "." in it. */
const HANDLE_LIKE =
  /^(?=[\p{L}\p{N}_.-]{4,}$)(?=.*\p{L})(?=.*[\p{N}_.])[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;
/** Any name of a few characters, when it follows the keyword and a colon ("инста: ivan"). */
const NAME_LIKE = /^(?=.*\p{L})[\p{L}\p{N}_.-]{3,}$/u;
const TRAILING_PUNCT = /[.,!?;:)»"']+$/u;
const LEADING_PUNCT = /^[(«"']+/u;

function findSocial(plain: string, latin: string, cyrillic: string): boolean {
  const tokensOf = (text: string) => text.replace(/:/g, ' : ').split(/\s+/).filter(Boolean);
  const plainTokens = tokensOf(plain);
  const latinTokens = tokensOf(latin);
  const cyrillicTokens = tokensOf(cyrillic);
  const strip = (token: string) => token.replace(TRAILING_PUNCT, '').replace(LEADING_PUNCT, '');
  for (let i = 0; i < plainTokens.length; i++) {
    const latinWord = strip(latinTokens[i] ?? '');
    const cyrillicWord = strip(cyrillicTokens[i] ?? '');
    if (!RU_KEYWORDS.test(cyrillicWord) && !EN_KEYWORDS.test(latinWord)) continue;
    // "инста: ivan": whatever follows a colon after the keyword is a name.
    if (plainTokens[i + 1] === ':') {
      const next = strip(plainTokens[i + 2] ?? '');
      if (NAME_LIKE.test(next)) return true;
    }
    for (let j = Math.max(0, i - 4); j <= Math.min(plainTokens.length - 1, i + 4); j++) {
      if (j === i) continue;
      if (HANDLE_LIKE.test(strip(plainTokens[j]!))) return true;
    }
  }
  return false;
}

// --- the filter ---------------------------------------------------------------------------------

/** The kind of contact in `text`, or null. Pure; never throws for a string input. */
export function findContact(text: string): ContactKind | null {
  const n = normalize(text);
  const latinViews = [n.latin, n.collapsed.latin];
  if (latinViews.some((v) => EMAIL.test(v))) return 'email';
  if (
    latinViews.some((v) => URL_FORMS.test(v) || DOMAIN_STRICT.test(v) || DOMAIN_LOOSE.test(v)) ||
    // Only as written: a Latin ".py" is not ".ру" (main.py is a file, not a site).
    [n.plain, n.collapsed.plain].some((v) => DOMAIN_CYRILLIC.test(v))
  ) {
    return 'url';
  }
  if (
    [n.plain, n.collapsed.plain].some((v) => AT_HANDLE.test(v) || AT_SPACED_HANDLE.test(v)) ||
    latinViews.some((v) => DISCORD_TAG.test(v) || VK_ID.test(v))
  ) {
    return 'handle';
  }
  if (longestDigitRun(n.plain) >= MIN_PHONE_DIGITS) return 'phone';
  if (findSocial(n.plain, n.latin, n.cyrillic)) return 'social';
  return null;
}

/**
 * The filter over a message and the sender's previous messages in the same chat: a contact split
 * across messages is caught when the pieces are read together, newest last.
 */
export function findContactInWindow(recent: readonly string[], text: string): ContactKind | null {
  return findContact(text) ?? (recent.length > 0 ? findContact([...recent, text].join(' ')) : null);
}
