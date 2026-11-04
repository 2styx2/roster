// Lazy `:help` in the built app, end to end (T213, #405, decision Q189): `vite build` into a temp
// folder, served as built (`vite preview`), on the fake Backend in headless Chromium, with every
// request off the app's own origin refused, as the installed app has no network for its own files.
// Startup doesn't load the guides' chunk; `:h <Tab>` completes a guide's heading from the tag
// table, `:help` opens the guide once the chunk (one of the app's own files) is read, and
// `:helpgrep` searches its text.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { build, preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch } from "./browser";

// The fake Backend's master password (src/backend/fake.ts FAKE_PASSWORD).
const FAKE_PASSWORD = "correct horse";
const APP = resolve(import.meta.dirname, "..");

let out = "";
let server: PreviewServer;
let origin = "";
let browser: Browser;
let context: BrowserContext;
let page: Page;
const requested: string[] = [];
const refused: string[] = [];

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "roster-lazy-help-"));
  const configFile = resolve(APP, "vite.config.ts");
  await build({ root: APP, configFile, logLevel: "warn", build: { outDir: out, emptyOutDir: true } });
  server = await preview({ root: APP, configFile, logLevel: "warn", build: { outDir: out }, preview: { port: 0, strictPort: false, host: "127.0.0.1" } });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("vite preview didn't listen on a port");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) {
      requested.push(url);
      return route.continue();
    }
    refused.push(url);
    return route.abort();
  });
  page = await context.newPage();
  await page.goto(`${origin}/index.html?toggle=off`);
  await page.getByLabel(/master password/i).fill(FAKE_PASSWORD);
  await page.keyboard.press("Enter");
  await page.getByRole("main", { name: /workspace/i }).waitFor();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

const guideChunk = () => requested.filter((u) => /\/assets\/guideText-[\w-]+\.js$/.test(u));

/** Types a command line after the Leader. */
async function command(line: string, end: "Enter" | "Tab" = "Enter") {
  await page.keyboard.press("Control+Space");
  await page.keyboard.type(`:${line}`);
  await page.keyboard.press(end);
}

describe("lazy :help in the built app", () => {
  it("starts without the guides' chunk", () => {
    expect(requested.some((u) => u.includes("/assets/index-"))).toBe(true);
    expect(guideChunk()).toEqual([]);
  });

  it(":h <Tab> completes a guide's heading, and :help opens it from the app's own chunk", async () => {
    await command("help config#the-sa", "Tab");
    await expect.poll(() => page.getByRole("combobox", { name: "Command" }).inputValue()).toBe("help config#the-sandbox");
    await page.keyboard.press("Enter");
    const help = page.getByRole("complementary", { name: "Help" });
    await help.getByRole("heading", { name: "The sandbox" }).waitFor();
    expect(guideChunk()).toHaveLength(1);
    expect(guideChunk()[0]?.startsWith(origin)).toBe(true);
    await page.keyboard.press("Escape");
  });

  it(":helpgrep searches the guides' text", async () => {
    await command("helpgrep bytecode");
    const grep = page.getByRole("dialog", { name: /search every help page/i });
    await grep.getByRole("option", { name: /The sandbox/ }).first().waitFor();
    await page.keyboard.press("Escape");
  });

  it("asked nothing of the network", () => {
    expect(refused).toEqual([]);
  });
});
