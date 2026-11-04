// The tag table (T213, decision Q189), as Neovim's doc/tags: every guide's topics (its headings, and
// deprecated.md's rows), made when the app is built. scripts/help-plugin.mjs runs this at build time
// and serves the result as `virtual:help-tags`, which startup reads, so `:help`, `:h <Tab>` and the
// topic finder know every guide's topics before the guides' text (guideText.ts) loads.
import { blockTags, guideBlocks, type PageTag } from "./guideBlocks";
import { guides } from "./guides";
import { guideTexts } from "./guideText";

/** Each guide's topics by its id, as topicIndex lists them once its text is loaded. */
export function tagTable(texts: Readonly<Record<string, string>> = guideTexts): Record<string, PageTag[]> {
  return Object.fromEntries(guides.map((g) => [g.id, blockTags(g.id, g.title, guideBlocks(g, texts[g.id] ?? ""))]));
}
