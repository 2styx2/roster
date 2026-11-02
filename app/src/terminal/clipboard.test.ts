// Copy and paste in the terminal (iteration 3 feedback): the keys, right-click as Windows Terminal
// does it, and pastes that reach the shell as xterm.js sends them (bracketed, line ends as Enter).
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { resolveKeymap } from "../keymap";
import { memoryPlatform } from "../platform/memory";
import { copyIfSelected, copySelection, pasteClipboard, rightClick, type Selectable } from "./clipboard";

/** A terminal's selection and what it sends to the shell, without a screen. */
function fakeTerm(selection = ""): Selectable & { sent: string[]; selection: string } {
  return {
    selection,
    sent: [],
    getSelection() {
      return this.selection;
    },
    hasSelection() {
      return this.selection !== "";
    },
    clearSelection() {
      this.selection = "";
    },
    paste(text: string) {
      this.sent.push(text);
    },
  };
}

describe("The terminal's copy and paste keys", () => {
  it.each([
    ["Ctrl+Shift+c", "terminal.copy"],
    ["Ctrl+Insert", "terminal.copy"],
    ["Ctrl+Shift+v", "terminal.paste"],
    ["Shift+Insert", "terminal.paste"],
  ])("%s is %s, from the keymap's terminal table (rebindable)", (chord, action) => {
    expect(resolveKeymap().terminal[chord]).toEqual({ action, source: "builtin" });
  });

  it("Ctrl+C copies only while something is selected, as in Windows Terminal", () => {
    const { terminal } = resolveKeymap();
    expect(terminal["Ctrl+c"]).toEqual({ action: "terminal.copyIfSelected", source: "builtin" });
  });

  it("Ctrl+V pastes the clipboard's text on Windows, as Windows Terminal (decision Q138)", () => {
    expect(resolveKeymap({}, { windows: true }).terminal["Ctrl+v"]).toEqual({ action: "terminal.pasteIfText", source: "builtin" });
  });

  it("Ctrl+V stays the program's elsewhere (Linux and macOS terminals paste with Ctrl+Shift+V)", () => {
    expect(resolveKeymap({}, { windows: false }).terminal["Ctrl+v"]).toBeUndefined();
    expect(resolveKeymap().terminal["Ctrl+v"]).toBeUndefined();
  });

  it("Ctrl+V can be unbound on Windows in init.lua", () => {
    expect(resolveKeymap({ terminal: { "Ctrl+v": null } }, { windows: true }).terminal["Ctrl+v"]).toBeUndefined();
  });

  it("can be unbound or moved in init.lua", () => {
    const { terminal } = resolveKeymap({ terminal: { "Shift+Insert": null, "Ctrl+v": "terminal.paste" } });
    expect(terminal["Shift+Insert"]).toBeUndefined();
    expect(terminal["Ctrl+v"]).toEqual({ action: "terminal.paste", source: "init.lua" });
  });
});

describe("Copying and pasting", () => {
  it("copies the selection, and nothing when there's none", async () => {
    const platform = memoryPlatform({ clipboard: "before" });
    expect(copySelection(fakeTerm(""), platform.clipboard)).toBe(false);
    expect(platform.clipboardText()).toBe("before");
    expect(copySelection(fakeTerm("ls -la\n/etc"), platform.clipboard)).toBe(true);
    await Promise.resolve();
    expect(platform.clipboardText()).toBe("ls -la\n/etc");
  });

  it("Ctrl+C with a selection copies it and clears it; without one it's the shell's interrupt", async () => {
    const platform = memoryPlatform({ clipboard: "old" });
    const term = fakeTerm("tail -f /var/log/syslog");
    expect(copyIfSelected(term, platform.clipboard)).toBe(true);
    await Promise.resolve();
    expect(platform.clipboardText()).toBe("tail -f /var/log/syslog");
    expect(term.hasSelection()).toBe(false);
    expect(copyIfSelected(term, platform.clipboard)).toBe(false);
    expect(platform.clipboardText()).toBe("tail -f /var/log/syslog");
  });

  it("pastes the clipboard through the terminal, and nothing when it's empty", async () => {
    const term = fakeTerm();
    await pasteClipboard(term, memoryPlatform({ clipboard: "" }).clipboard);
    expect(term.sent).toEqual([]);
    await pasteClipboard(term, memoryPlatform({ clipboard: "uptime" }).clipboard);
    expect(term.sent).toEqual(["uptime"]);
  });

  it("right-click copies the selection and clears it, or pastes when there's none (Windows Terminal)", async () => {
    const platform = memoryPlatform({ clipboard: "old" });
    const term = fakeTerm("10.19.1.2");
    await rightClick(term, platform.clipboard);
    expect(platform.clipboardText()).toBe("10.19.1.2");
    expect(term.hasSelection()).toBe(false);
    expect(term.sent).toEqual([]);
    await rightClick(term, platform.clipboard);
    expect(term.sent).toEqual(["10.19.1.2"]);
  });

  // Windows Terminal (ControlInteractivity.cpp, PointerPressed): while a program has mouse
  // reporting on, a click without Shift is the program's (_canSendVTMouseInput), right-click too.
  it("with mouse reporting on and nothing selected, right-click is the program's: no paste (Windows Terminal)", async () => {
    const platform = memoryPlatform({ clipboard: "rm -rf ~" });
    const term = fakeTerm("");
    await rightClick(term, platform.clipboard, { programHasMouse: true });
    expect(term.sent).toEqual([]);
    expect(platform.clipboardText()).toBe("rm -rf ~");
  });

  it("Shift+right-click under mouse reporting pastes as without it (the program never sees it)", async () => {
    const term = fakeTerm("");
    await rightClick(term, memoryPlatform({ clipboard: "uptime" }).clipboard, { programHasMouse: false });
    expect(term.sent).toEqual(["uptime"]);
  });

  it("a Shift+drag selection under mouse reporting: right-click copies it and clears it", async () => {
    const platform = memoryPlatform({ clipboard: "old" });
    const term = fakeTerm("10.0.0.5 esx-02");
    await rightClick(term, platform.clipboard, { programHasMouse: true });
    expect(platform.clipboardText()).toBe("10.0.0.5 esx-02");
    expect(term.hasSelection()).toBe(false);
    expect(term.sent).toEqual([]);
  });

  it("copies each line without the spaces after its end, as Windows Terminal trims them", async () => {
    const platform = memoryPlatform({ clipboard: "" });
    expect(copySelection(fakeTerm("ab        \nxy     z   \n  indented  "), platform.clipboard)).toBe(true);
    await Promise.resolve();
    expect(platform.clipboardText()).toBe("ab\nxy     z\n  indented");
  });

  it("a selection of nothing but spaces copies nothing", () => {
    const platform = memoryPlatform({ clipboard: "kept" });
    expect(copySelection(fakeTerm("     "), platform.clipboard)).toBe(false);
    expect(platform.clipboardText()).toBe("kept");
  });

  it("a failing clipboard doesn't throw (the WebView can refuse it)", async () => {
    const broken = { readText: () => Promise.reject(new Error("denied")), writeText: () => Promise.reject(new Error("denied")) };
    expect(copySelection(fakeTerm("x"), broken)).toBe(true);
    await expect(pasteClipboard(fakeTerm(), broken)).resolves.toBeUndefined();
  });
});

describe("What a paste sends to the shell (xterm.js)", () => {
  const sent = async (text: string, bracketed: boolean) => {
    const t = new Terminal({ allowProposedApi: true });
    const out: string[] = [];
    t.onData((d) => out.push(d));
    if (bracketed) await new Promise<void>((done) => t.write("\x1b[?2004h", done));
    await pasteClipboard(t, memoryPlatform({ clipboard: text }).clipboard);
    t.dispose();
    return out.join("");
  };

  it("sends several lines with each line end as Enter (CR), as a typed one would be", async () => {
    expect(await sent("echo one\necho two\r\necho three", false)).toBe("echo one\recho two\recho three");
  });

  it("takes control characters out of it, so the end mark in a paste can't end it early (right-click too)", async () => {
    const out = await sent("safe\x1b[201~rm -rf /tmp/x\n", true);
    expect(out).toBe("\x1b[200~safe[201~rm -rf /tmp/x\r\x1b[201~");
    const term = fakeTerm();
    await rightClick(term, memoryPlatform({ clipboard: "x\x1b[201~y" }).clipboard);
    expect(term.sent).toEqual(["x[201~y"]);
  });

  it("wraps it in bracketed-paste marks when the shell asked for them, so it doesn't run line by line", async () => {
    expect(await sent("echo one\necho two\n", true)).toBe("\x1b[200~echo one\recho two\r\x1b[201~");
  });
});
