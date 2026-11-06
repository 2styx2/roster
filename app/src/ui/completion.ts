// Shell-style completion's first step (ticket 34): before cycling, Tab fills in what every
// candidate starting with the typed text shares, as bash and zsh do. The command line, the
// Picker and the finders use the same rule.

/** The longest prefix every word shares, compared without case; spelled as the first word has it. */
export function commonPrefix(words: readonly string[]): string {
  const [first, ...rest] = words;
  if (first === undefined) return "";
  let n = first.length;
  const lower = first.toLowerCase();
  for (const w of rest) {
    const l = w.toLowerCase();
    let i = 0;
    while (i < n && i < l.length && l[i] === lower[i]) i++;
    n = i;
  }
  return first.slice(0, n);
}

/** What Tab fills in for `typed`: the common prefix of the candidates that start with it (without
 * case), when that's longer than what's typed; otherwise null (Tab moves on instead). */
export function prefixFill(typed: string, candidates: readonly string[]): string | null {
  const t = typed.toLowerCase();
  const starting = candidates.filter((c) => c.toLowerCase().startsWith(t));
  const shared = commonPrefix(starting);
  return shared.length > typed.length ? shared : null;
}

/** Names that start with `word` first, then the rest that contain it, without case. */
export function matching(names: readonly string[], word: string): string[] {
  const w = word.toLowerCase();
  const lower = (n: string) => n.toLowerCase();
  return [...names.filter((n) => lower(n).startsWith(w)), ...names.filter((n) => !lower(n).startsWith(w) && lower(n).includes(w))];
}
