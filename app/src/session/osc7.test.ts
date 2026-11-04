import { describe, expect, it } from "vitest";
import { FOLDER_MAX, folderOf } from "./osc7";

// #242: OSC 7 comes from the Host's shell, so it's untrusted: only a plain `file://HOST/PATH`
// with a host name roster can read, and a folder with nothing in it that could draw or move
// anything, is a folder. Anything else is no folder at all, never a cleaned-up guess.
describe("the folder in an OSC 7", () => {
  it("is the path of a file:// URL, with or without a host", () => {
    expect(folderOf("file://web-01/home/user")).toBe("/home/user");
    expect(folderOf("file://web-01.example.com/srv/app")).toBe("/srv/app");
    expect(folderOf("file:///tmp")).toBe("/tmp");
    expect(folderOf("file://localhost/")).toBe("/");
  });

  it("is percent-decoded, as UTF-8; a % that starts no escape is a %", () => {
    expect(folderOf("file://web-01/home/user/my%20src")).toBe("/home/user/my src");
    expect(folderOf("file://web-01/srv/caf%C3%A9")).toBe("/srv/café");
    // The hooks send $PWD as it is, not encoded.
    expect(folderOf("file://web-01/srv/100%")).toBe("/srv/100%");
    expect(folderOf("file://web-01/bad%zz")).toBe("/bad%zz");
    expect(folderOf("file://web-01/srv/my src")).toBe("/srv/my src");
  });

  it("keeps a Windows path as PowerShell's hook sends it", () => {
    expect(folderOf("file://WS-01/C:/Users/you")).toBe("/C:/Users/you");
  });

  it("is nothing for anything but a file:// URL", () => {
    for (const s of ["", "/home/user", "http://web-01/home", "FILE:/home", "file:/home", "file://web-01", "kitty-shell-cwd://web-01/home"]) {
      expect(folderOf(s), s).toBeNull();
    }
  });

  it("is nothing when the host part isn't a plain host name", () => {
    for (const s of ["file://you@web-01/home", "file://web-01:22/home", "file://web%2D01/home", "file://[::1]/home", "file://web 01/home", `file://${"a".repeat(254)}/home`]) {
      expect(folderOf(s), s).toBeNull();
    }
  });

  it("is nothing with a control character in it, raw or percent-encoded", () => {
    for (const s of ["file://web-01/home/\x1b[31m", "file://web-01/a%1Bb", "file://web-01/a%0Ab", "file://web-01/a%7Fb", "file://web-01/a%C2%9Bb", "file://web-01/a\tb"]) {
      expect(folderOf(s), JSON.stringify(s)).toBeNull();
    }
  });

  it("is nothing with a character that reorders or breaks the text it's shown in", () => {
    // Right-to-left override, isolates, marks, line and paragraph separators.
    for (const c of ["\u202e", "\u2066", "\u2069", "\u200f", "\u2028", "\u2029"]) {
      expect(folderOf(`file://web-01/srv/${c}gpj.exe`), JSON.stringify(c)).toBeNull();
    }
    expect(folderOf("file://web-01/srv/%E2%80%AEgpj")).toBeNull();
  });

  // Review of #426, L1: every format character (Unicode's Cf), not only the bidi ones.
  it("is nothing with an invisible format character in it, raw or percent-encoded", () => {
    for (const c of ["\u061c", "\u200b", "\u200c", "\u200d", "\u2060", "\u2064", "\ufeff", "\u00ad", "\u{e0001}", "\u{e0041}", "\u{e007f}"]) {
      expect(folderOf(`file://web-01/srv/a${c}b`), JSON.stringify(c)).toBeNull();
      const encoded = [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
      expect(folderOf(`file://web-01/srv/a${encoded}b`), encoded).toBeNull();
    }
  });

  it("is nothing when the escapes aren't UTF-8", () => {
    expect(folderOf("file://web-01/srv/%FF%FE")).toBeNull();
    expect(folderOf("file://web-01/srv/%C3")).toBeNull();
  });

  it("is nothing when it's longer than FOLDER_MAX, never a cut one", () => {
    const fits = `/${"a".repeat(FOLDER_MAX - 1)}`;
    expect(folderOf(`file://web-01${fits}`)).toBe(fits);
    expect(folderOf(`file://web-01${fits}b`)).toBeNull();
    expect(folderOf(`file://web-01/${"%20".repeat(FOLDER_MAX)}`)).toBeNull();
  });
});
