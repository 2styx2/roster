// A unified diff as git prints it, line by line: roster.yml's pending changes (ChangesPanel.tsx)
// and a Package's update (PluginsPanel.tsx) draw it the same way.

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "same";

/** One diff line's kind, for its colour and its sign in words. */
export function kindOf(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "same";
}

/** What a screen reader hears for an added or removed line's sign. */
export const SIGN_WORD = { add: "added: ", del: "removed: " } as const;

/** The short hash git shows. */
export const shortCommit = (commit: string | null) => (commit ?? "").slice(0, 7);
