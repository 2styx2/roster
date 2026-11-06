import { describe, expect, it } from "vitest";
import { messageParts } from "./messageParts";
import { keyCancelled } from "../session/Sessions";

const commands = (text: string) => messageParts(text).filter((p) => p.command).map((p) => p.text);

describe("the commands a message names (round 18)", () => {
  it("marks each command with at most one lowercase argument, not the sentence's punctuation", () => {
    expect(commands("Not a command: blah. :help commands lists them.")).toEqual(["blah", ":help commands"]);
    expect(commands("Add reviewed: true to it in roster.yml (:help adding-hosts).")).toEqual([":help adding-hosts"]);
    expect(commands("Pick another name, or edit that Host (:edit HOST).")).toEqual([":edit"]);
    expect(commands("Run :config, then :source.")).toEqual([":config", ":source"]);
    expect(commands("E13: at 10:30, see https://example.test")).toEqual([]);
  });

  it("sets what was typed, quoted back by a slip, as data (round 19)", () => {
    expect(commands("No help for zzqxj.")).toEqual(["zzqxj"]);
    expect(commands("Not a command: host.add. :help commands lists them.")).toEqual(["host.add", ":help commands"]);
    expect(commands("Saved. Not a word was changed.")).toEqual([]);
  });

  it("sets the Host a cancelled key question names as data, not its \"'s\" (round 22)", () => {
    const text = keyCancelled("linux-1-000");
    expect(commands(text)).toEqual(["linux-1-000"]);
    expect(messageParts(text).map((p) => p.text).join("")).toBe(text);
    expect(commands(keyCancelled("10.0.0.5"))).toEqual(["10.0.0.5"]);
    expect(commands("I didn't trust it's key.")).toEqual([]);
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

  it("marks a setting with its yes/no value as data too (round 21)", () => {
    const text = "linux-1-024 isn't reviewed yet, so it can't be opened. Add reviewed: true to it in roster.yml (:help adding-hosts).";
    expect(files(text)).toEqual(["reviewed: true", "roster.yml"]);
    expect(messageParts(text, true).map((p) => p.text).join("")).toBe(text);
    expect(files("Note: true enough.")).toEqual([]);
    expect(files("Saved: 3 Hosts.")).toEqual([]);
  });
});

describe("the keys a message names (round 21)", () => {
  const keys = (text: string) => messageParts(text).filter((p) => p.keys).map((p) => p.text);
  it("marks the Leader and the keys after it, not the sentence's full stop or the words after", () => {
    expect(keys("No Session to fill. Open one with ␣ f.")).toEqual(["␣ f"]);
    expect(keys("Press ␣ d d to close it, or ␣ Ctrl+x.")).toEqual(["␣ d d", "␣ Ctrl+x"]);
    expect(keys("Open one with ␣ f to start")).toEqual(["␣ f"]);
    expect(keys("No Session to fill. Open one with :open HOST.")).toEqual([]);
  });

  it("keeps the whole text, in order, for :messages and the tooltip", () => {
    const text = "No Session to fill. Open one with ␣ f.";
    expect(messageParts(text).map((p) => p.text).join("")).toBe(text);
  });
});
