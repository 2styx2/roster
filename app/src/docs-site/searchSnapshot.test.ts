// The docs website's search gives the same results from its shards as from one index, query for
// query (T260, #528). A fixed set of queries runs over the index as a page loads it (search-topics.js,
// then each text shard it names, run as the scripts they are) and over the whole index the build
// wrote them from; every result must be the same, in the same order.
//
// The results were first snapshotted from the one search-index.js and passed unchanged over the
// shards (the pull request's first two commits); this compares the two ways instead, so a docs
// change, which changes the results themselves, doesn't have to update a snapshot.
import { describe, expect, it } from "vitest";
import { joinIndex, searchDocs, type SearchIndex, type SearchTopics } from "./search";
import { buildSite, siteContext, type SiteFile } from "./site";

const OPTS = { sha: "0123456789abcdef0123456789abcdef01234567", repo: "example/roster", version: "9.8.7", fileExists: () => true };

/** Topics exact and by scattered letters, text of one word and of several, a heading, an option,
 * a command, a serve method, an error code, punctuation, and nothing at all. */
const QUERIES = [
  "terminal.size",
  "cnct",
  "sandbox",
  "the sandbox",
  "font size",
  ":connect",
  "ssh config",
  "vault unlock",
  "known_hosts",
  "roster.keymap",
  "plugin",
  "session.fill",
  "rotate key",
  "mesh",
  "141 inventory",
  "init.lua",
  "windows",
  "theme",
  "news",
  "zzqqxx",
];

/** The index as a page's search.js gets it: search-topics.js first, then every text shard it
 * names, each run as the script it is (the build writes plain scripts, for file:// too). */
function loadIndex(files: SiteFile[]): SearchIndex {
  const win: Record<string, unknown> = {};
  const run = (path: string) => {
    const f = files.find((x) => x.path === path);
    if (!f) throw new Error(`no ${path}`);
    new Function("window", f.body)(win);
  };
  run("search-topics.js");
  const topics = win.rosterSearchTopics as SearchTopics;
  for (const shard of topics.shards) run(shard);
  return joinIndex(topics, topics.shards.map((_, i) => (win.rosterSearchText as SearchIndex["texts"][])[i] ?? []));
}

describe("the docs website's search results", () => {
  const site = buildSite(siteContext(), OPTS);
  const whole = site.searchIndex as SearchIndex;
  const sharded = loadIndex(site.files);

  it("load back as the whole index", () => {
    expect(sharded).toEqual(whole);
  });

  it.each(QUERIES)("are the same from the shards as from one index for %j", (query) => {
    const r = searchDocs(sharded, query);
    expect(r).toEqual(searchDocs(whole, query));
    if (query !== "zzqqxx") expect(r.topics.length + r.texts.length, query).toBeGreaterThan(0);
  });
});
