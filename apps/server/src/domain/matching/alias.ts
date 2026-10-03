/** Anonymous names for a match, drawn from the content aliases. */

/**
 * Picks two different aliases. `aliasA` is how user A appears to user B, so it avoids the names B
 * already sees in open matches (and the other way round); with enough aliases a user never sees
 * the same name on two open chats.
 */
export function pickAliases(
  aliases: readonly string[],
  seenByA: ReadonlySet<string>,
  seenByB: ReadonlySet<string>,
  random: () => number,
): { aliasA: string; aliasB: string } {
  if (aliases.length < 2) throw new Error('alias generation needs at least two content aliases');
  const draw = (taken: ReadonlySet<string>, other: string | null): string => {
    const free = aliases.filter((a) => a !== other && !taken.has(a));
    // Everything in use: fall back to any name that differs from the partner's.
    const options = free.length > 0 ? free : aliases.filter((a) => a !== other);
    return options[Math.floor(random() * options.length)]!;
  };
  const aliasA = draw(seenByB, null);
  const aliasB = draw(seenByA, aliasA);
  return { aliasA, aliasB };
}
