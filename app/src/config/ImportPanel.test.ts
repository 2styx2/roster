// The import's diff as shown (ticket 33): its changes with two lines of context, the rest folded.
import { describe, expect, it } from "vitest";
import { hunks } from "./ImportPanel";
import type { DiffLine } from "./types";

const same = (text: string): DiffLine => ({ kind: "same", text });

describe("hunks", () => {
  it("keeps two lines around each change and folds the rest to one gap", () => {
    const diff: DiffLine[] = [same("1"), same("2"), same("3"), same("4"), same("5"), { kind: "add", text: "new" }, same("6"), same("7"), same("8")];
    expect(hunks(diff).map((l) => `${l.kind}:${l.text}`)).toEqual(["gap:…", "same:4", "same:5", "add:new", "same:6", "same:7", "gap:…"]);
  });
});

import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { ImportPanel } from "./ImportPanel";

describe("ImportPanel", () => {
  it("says when init.lua already has the profile", () => {
    const preview = { settingsPath: "s.json", summary: [], diff: [same("return {}")], overridden: [], created: false, base: "b", result: "r", date: "2026-10-30", error: null, theme: null };
    render(createElement(ImportPanel, { preview, problem: null, writing: false, onWrite() {}, onClose() {} }));
    expect(screen.getByText(/already has this profile/)).toBeInTheDocument();
  });

  it("names what wins over the import: the returned table, or a line after the block, at its line", () => {
    const preview = {
      settingsPath: "s.json",
      summary: [],
      diff: [{ kind: "add" as const, text: "roster.o.terminal.size = \"16pt\"" }],
      overridden: [
        { option: "terminal.font", by: "returned" as const, at: null },
        { option: "terminal.size", by: "later" as const, at: { file: "init.lua", line: 42 } },
      ],
      created: false,
      base: "b",
      result: "r",
      date: "2026-10-30",
      error: null,
      theme: null,
    };
    render(createElement(ImportPanel, { preview, problem: null, writing: false, onWrite() {}, onClose() {} }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("init.lua's returned table sets terminal.font, and it wins over the import. Delete it there to use Windows Terminal's.");
    expect(dialog).toHaveTextContent("init.lua:42 sets terminal.size again after the import block, and the later line wins. Delete it there to use Windows Terminal's.");
  });
});
