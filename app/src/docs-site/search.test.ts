// The docs website's search (ticket 65): the same topics as `:help` and the same text as
// `:helpgrep`, ranked the same way, over the index the site build writes (search-index.js).
import { describe, expect, it } from "vitest";
import { searchDocs, type SearchIndex } from "./search";

const INDEX: SearchIndex = {
  topics: [
    ["options", "Options", "", "options.html"],
    ["terminal.size", "terminal.size", "The terminal's font size", "options.html#terminal.size"],
    [":connect", ":connect", "Open a Session to HOST", "commands.html#%3Aconnect"],
    ["config#the-sandbox", "The sandbox", "Your init.lua", "config.html#the-sandbox"],
  ],
  places: [
    ["config.html#the-sandbox", "Your init.lua › The sandbox"],
    ["options.html#terminal.size", "Options › terminal.size"],
  ],
  texts: [
    [0, "init.lua runs in a sandbox: no os, no io."],
    [1, "terminal.size 13 The terminal's font size, in pixels."],
  ],
};

describe("searching the docs website", () => {
  it("finds nothing for an empty query", () => {
    expect(searchDocs(INDEX, "  ")).toEqual({ topics: [], texts: [] });
  });

  it("ranks topics like :help's topic finder: an exact tag first", () => {
    const { topics } = searchDocs(INDEX, "terminal.size");
    expect(topics[0]).toMatchObject({ tag: "terminal.size", href: "options.html#terminal.size", label: "terminal.size" });
  });

  it("matches a topic by scattered letters, as the finder does", () => {
    expect(searchDocs(INDEX, "cnct").topics.map((t) => t.tag)).toEqual([":connect"]);
  });

  it("finds text that has every word, with where it is", () => {
    const { texts } = searchDocs(INDEX, "sandbox");
    expect(texts.map((t) => t.label)).toEqual(["init.lua runs in a sandbox: no os, no io."]);
    expect(texts[0]?.where).toBe("Your init.lua › The sandbox");
    expect(searchDocs(INDEX, "sandbox pixels").texts).toEqual([]);
  });

  it("finds a heading as the topic it is", () => {
    expect(searchDocs(INDEX, "the sandbox").topics.map((t) => t.tag)).toEqual(["config#the-sandbox"]);
  });

  it("lists a place once when two topics go to it (an alias and what it names)", () => {
    const withAlias: SearchIndex = { ...INDEX, topics: [...INDEX.topics, ["sandbox", "sandbox", "The sandbox", "config.html#the-sandbox"]] };
    expect(searchDocs(withAlias, "sandbox").topics.map((t) => t.href)).toEqual(["config.html#the-sandbox"]);
  });

  it("links a text match to its place, asking the page to mark the first word", () => {
    const [hit] = searchDocs(INDEX, "font pixels").texts;
    expect(hit?.href).toBe("options.html?hl=font#terminal.size");
  });

  it("gives the words to mark in a snippet", () => {
    expect(searchDocs(INDEX, "Font  PIXELS").terms).toEqual(["font", "pixels"]);
  });
});
