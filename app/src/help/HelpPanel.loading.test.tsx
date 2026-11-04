// What the help panel shows of a guide whose text takes past 150 ms to load (T213): its title and a
// status line, no motion; and when the text couldn't load, why and how to try again.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config/fixture";
import { defaultOptions, keymapOf } from "../keymap";
import { builtinRegistries } from "../registries";
import { HelpView, type HelpSnapshot } from "./command";
import { HelpPanel } from "./HelpPanel";
import { helpContext } from "./pages";

function panel(snapshot: HelpSnapshot) {
  const r = builtinRegistries();
  const ctx = helpContext(r, { keymap: keymapOf(r.keymap.list()), options: defaultOptions, config: defaultConfig, configPath: null, state: {}, activeTheme: null });
  render(<HelpPanel view={new HelpView()} snapshot={snapshot} ctx={ctx} leader="Ctrl+Space" vim={false} onFind={() => {}} onOutline={() => {}} />);
}

describe("a guide still loading", () => {
  it("shows its title and says it's loading", () => {
    panel({ at: { page: "keyboard" }, canBack: false, canForward: false, seq: 1, loading: true });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Keyboard");
    expect(screen.getByText("Loading this page…")).toHaveAttribute("role", "status");
  });

  it("says why it couldn't load, and how to try again", () => {
    panel({ at: { page: "keyboard", anchor: "keyboard#two-modes" }, canBack: false, canForward: false, seq: 1, loading: false, failed: "no chunk" });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load help's guides: no chunk. :help keyboard#two-modes tries again.");
  });
});
