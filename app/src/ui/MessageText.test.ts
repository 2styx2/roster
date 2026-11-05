import { describe, expect, it } from "vitest";
import { messageParts } from "./MessageText";

const commands = (text: string) => messageParts(text).filter((p) => p.command).map((p) => p.text);

describe("the commands a message names (round 18)", () => {
  it("marks each command with at most one lowercase argument, not the sentence's punctuation", () => {
    expect(commands("Not a command: blah. :help commands lists them.")).toEqual(["blah", ":help commands"]);
    expect(commands("Set reviewed: true for it in roster.yml (:help adding-hosts).")).toEqual([":help adding-hosts"]);
    expect(commands("Pick another name, or edit that Host (:edit HOST).")).toEqual([":edit"]);
    expect(commands("Run :config, then :source.")).toEqual([":config", ":source"]);
    expect(commands("E13: at 10:30, see https://example.test")).toEqual([]);
  });

  it("sets what was typed, quoted back by a slip, as data (round 19)", () => {
    expect(commands("No help for zzqxj.")).toEqual(["zzqxj"]);
    expect(commands("Not a command: host.add. :help commands lists them.")).toEqual(["host.add", ":help commands"]);
    expect(commands("Saved. Not a word was changed.")).toEqual([]);
  });

  it("keeps the whole text, in order", () => {
    const text = "Not a command: blah. :help commands lists them.";
    expect(messageParts(text).map((p) => p.text).join("")).toBe(text);
  });
});
