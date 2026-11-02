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

  it("wraps it in bracketed-paste marks when the shell asked for them, so it doesn't run line by line", async () => {
    expect(await sent("echo one\necho two\n", true)).toBe("\x1b[200~echo one\recho two\r\x1b[201~");
  });
});
