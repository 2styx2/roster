/** Names that start with `word` first, then the rest that contain it, without case. */
export function matching(names: readonly string[], word: string): string[] {
  const w = word.toLowerCase();
  const lower = (n: string) => n.toLowerCase();
  return [...names.filter((n) => lower(n).startsWith(w)), ...names.filter((n) => !lower(n).startsWith(w) && lower(n).includes(w))];
}
