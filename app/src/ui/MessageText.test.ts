import { describe, expect, it } from "vitest";
import { messageParts } from "./MessageText";

const commands = (text: string) => messageParts(text).filter((p) => p.command).map((p) => p.text);

describe("the commands a message names (round 18)", () => {
  it("marks each command with at most one lowercase argument, not the sentence's punctuation", () => {
    expect(commands("Not a command: blah. :help commands lists them.")).toEqual([":help commands"]);
    expect(commands("Set reviewed: true for it in roster.yml (:help adding-hosts).")).toEqual([":help adding-hosts"]);
    expect(commands("Pick another name, or edit that Host (:edit HOST).")).toEqual([":edit"]);
    expect(commands("Run :config, then :source.")).toEqual([":config", ":source"]);
    expect(commands("E13: at 10:30, see https://example.test")).toEqual([]);
  });

  it("keeps the whole text, in order", () => {
    const text = "Not a command: blah. :help commands lists them.";
    expect(messageParts(text).map((p) => p.text).join("")).toBe(text);
  });
});

describe("the files a message names (round 19)", () => {
  const files = (text: string) => messageParts(text, true).filter((p) => p.file).map((p) => p.text);
  it("marks roster.yml and init.lua as data, not the sentence's full stop", () => {
    const text = "Adding Hosts here needs a newer roster. Update roster on this Box, or add them to roster.yml.";
    expect(files(text)).toEqual(["roster.yml"]);
    expect(messageParts(text, true).map((p) => p.text).join("")).toBe(text);
    expect(messageParts(text).some((p) => p.file)).toBe(false);
    expect(files("Set it in init.lua (:help config).")).toEqual(["init.lua"]);
    expect(files("a newer roster. Update it")).toEqual([]);
  });
});
