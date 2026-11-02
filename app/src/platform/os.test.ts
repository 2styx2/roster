import { describe, expect, it } from "vitest";
import { runsOnWindows } from "./os";

describe("runsOnWindows", () => {
  it.each([
    ["WebView2", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Edg/140.0" }, true],
    ["Chromium's platform", { userAgent: "", userAgentData: { platform: "Windows" } }, true],
    ["WebKitGTK", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15" }, false],
    ["WKWebView", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" }, false],
    ["no navigator (the docs build)", undefined, false],
  ])("%s", (_, nav, windows) => {
    expect(runsOnWindows(nav)).toBe(windows);
  });

  it("is false in the tests' jsdom", () => {
    expect(runsOnWindows()).toBe(false);
  });
});
