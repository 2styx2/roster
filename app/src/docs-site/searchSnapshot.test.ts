// The docs website's search gives the same results over the index the build writes, query for query
// (T260, #528): a fixed set of queries, each result list summed up as its counts, its first few
// results and a hash of every result, so a change to how the index is written or loaded that
// changes any result shows here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { searchDocs, type SearchIndex } from "./search";
import { buildSite, siteContext } from "./site";

const OPTS = { sha: "0123456789abcdef0123456789abcdef01234567", repo: "example/roster", version: "9.8.7", fileExists: () => true };

/** Topics exact and by scattered letters, text of one word and of several, a heading, an option,
 * a command, a serve method, an error code, punctuation, and nothing at all. */
const QUERIES = [
  "terminal.size",
  "cnct",
  "sandbox",
  "the sandbox",
  "font pixels",
  ":connect",
  "ssh config",
  "vault unlock",
  "known_hosts",
  "roster.keymap",
  "plugin",
  "session.fill",
  "rotate key",
  "mesh",
  "error 141",
  "init.lua",
  "windows",
  "theme",
  "news",
  "zzqqxx",
];

function loadIndex(files: { path: string; body: string }[]): SearchIndex {
  const js = files.find((f) => f.path === "search-index.js")?.body ?? "";
  const m = /^window\.rosterSearchIndex = (.*);\n$/s.exec(js);
  if (!m) throw new Error("no search-index.js");
  return JSON.parse(m[1] as string) as SearchIndex;
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

describe("the docs website's search results", () => {
  const index = loadIndex(buildSite(siteContext(), OPTS).files);

  it.each(QUERIES)("are the same for %j", (query) => {
    const r = searchDocs(index, query);
    expect({
      topics: r.topics.length,
      texts: r.texts.length,
      firstTopics: r.topics.slice(0, 5).map((t) => t.href),
      firstTexts: r.texts.slice(0, 5).map((t) => `${t.href} ${t.label}`),
      all: hash(r),
    }).toMatchSnapshot();
  });
});
