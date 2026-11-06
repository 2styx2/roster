// @vitest-environment node
// The core documents init.lua's `statusbar` and `toolbar` with the app's ids (config/schema.rs's
// doc comments, which ts-rs carries into config/core.gen.ts, and shape/table.rs's `takes`, in
// config-options.json). The app's registries are the source: this fails when the two drift.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import options from "../../../crates/roster-core/tests/fixtures/config-options.json";
import { builtinControls } from "../chrome/toolbar";
import { STATUS_SEGMENTS } from "./segments";

const coreGen = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../config/core.gen.ts"), "utf8");
const quoted = (text: string) => [...text.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

describe("the core's docs name the app's ids", () => {
  it("the status bar's segments, in order (StatusBarPiece, the statusbar option)", () => {
    const piece = /Segment ids in order \(([^)]*)\)/.exec(coreGen)?.[1] ?? "";
    expect(quoted(piece)).toEqual(STATUS_SEGMENTS);
    const takes = JSON.stringify(options).match(/segments in order: ((?:\\"[a-z]+\\"(?:, )?)+)/g) ?? [];
    expect(takes.length).toBeGreaterThan(0);
    for (const t of takes) expect(quoted(t.replaceAll('\\"', '"'))).toEqual(STATUS_SEGMENTS);
  });

  it("the toolbar's controls, the default set first (ToolbarPiece)", () => {
    const piece = /ids from the app's toolbar registry: ([^;]*);/.exec(coreGen.replace(/\n \* /g, " "))?.[1] ?? "";
    const [shown = "", hidden = ""] = piece.split("and the ones not shown by default");
    expect(quoted(shown)).toEqual(builtinControls.filter((c) => c.byDefault).map((c) => c.id));
    expect(quoted(hidden)).toEqual(builtinControls.filter((c) => !c.byDefault).map((c) => c.id));
  });
});
