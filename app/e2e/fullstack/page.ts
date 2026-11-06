// The suite's side of the page: one headless Chromium per file, the real app on a stack
// (stack.ts), and what a test reads back (the terminal's text, every console line).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach } from "vitest";
import type { Stack } from "./stack";

/** The bridge's events so far, in order (tauri/core.ts). */
export type Sent = { e2eEvents: { event: string; payload: unknown }[] };

export async function launch(): Promise<Browser> {
  return chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ["--no-sandbox"] } : {});
}

export interface AppPage {
  page: Page;
  /** Every console message and page error so far. */
  logs: string[];
  /** The visible terminal's text, row by row (the DOM renderer, stack.ts's init.lua). */
  terminal(): Promise<string>;
  /** Waits until the visible terminal shows `text`. */
  terminalShows(text: string | RegExp): Promise<string>;
  /** The page's whole text, its form fields' values and its storage, for a secret check. */
  everything(): Promise<string>;
  /** How many `event`s the bridge has sent the page so far. */
  eventCount(event: string): Promise<number>;
  /** Waits for the bridge's next `event` after the first `after` of them; gives its payload. */
  nextEvent<T = unknown>(event: string, after: number): Promise<T>;
  /** Runs an Ex command from the command line (`:` then `line`, then Enter). */
  ex(line: string): Promise<void>;
  /** With `$E2E_DUMP_DIR` set: the page's accessibility tree, terminal, console and a screenshot,
   * as `NAME.txt` and `NAME.png` there (afterEach calls it for a failed test). */
  dump(name: string): Promise<void>;
}

/** Dumps the page after a failed test, when `$E2E_DUMP_DIR` asks for it. */
export function dumpFailures(app: () => AppPage | undefined) {
  afterEach(async (ctx) => {
    if (ctx.task.result?.state === "fail") await app()?.dump(ctx.task.name.replace(/[^\w-]+/g, "_"));
  });
}

export async function openApp(browser: Browser, stack: Stack, size = { width: 1280, height: 800 }): Promise<AppPage> {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  // The visible terminal's rows as text (the DOM renderer draws a space as U+00A0).
  await page.addInitScript(() => {
    (window as unknown as { e2eTerminal: () => string }).e2eTerminal = () => {
      const shown = [...document.querySelectorAll<HTMLElement>(".xterm-rows")].find((r) => r.offsetParent !== null);
      return [...(shown?.children ?? [])].map((r) => (r.textContent ?? "").replace(/\u00a0/g, " ").trimEnd()).join("\n");
    };
  });
  await page.goto(stack.pageUrl);
  const terminal = () => page.evaluate(() => (window as unknown as { e2eTerminal: () => string }).e2eTerminal());
  return {
    page,
    logs,
    terminal,
    async terminalShows(text) {
      await page.waitForFunction(
        ([source, flags, plain]) => {
          const t = (window as unknown as { e2eTerminal: () => string }).e2eTerminal();
          return plain ? t.includes(plain) : new RegExp(source!, flags!).test(t);
        },
        typeof text === "string" ? [null, null, text] : [text.source, text.flags, null],
        { timeout: 60_000 },
      );
      return terminal();
    },
    everything: () =>
      page.evaluate(() => {
        const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].map((f) => f.value);
        const store = (s: Storage) => Object.keys(s).map((k) => `${k}=${s.getItem(k) ?? ""}`);
        return [document.documentElement.outerHTML, document.body.innerText, ...fields, ...store(localStorage), ...store(sessionStorage)].join("\n");
      }),
    eventCount: (event) => page.evaluate((name) => (window as unknown as Sent).e2eEvents.filter((e) => e.event === name).length, event),
    async nextEvent<T>(event: string, after: number) {
      const got = await page.waitForFunction(
        ([name, n]) => (window as unknown as Sent).e2eEvents.filter((e) => e.event === name)[n] ?? false,
        [event, after] as const,
        { timeout: 60_000 },
      );
      return ((await got.jsonValue()) as { payload: T }).payload;
    },
    async dump(name) {
      const dir = process.env.E2E_DUMP_DIR;
      if (!dir) return;
      const tree = await page.locator("body").ariaSnapshot().catch((e: Error) => e.message);
      writeFileSync(join(dir, `${name}.txt`), [tree, await terminal().catch(() => ""), logs.join("\n"), stack.stderr()].join("\n-----\n"));
      await page.screenshot({ path: join(dir, `${name}.png`) }).catch(() => {});
    },
    async ex(line) {
      await page.keyboard.press("Control+Space");
      await page.keyboard.press(":");
      const cmdline = page.getByRole("combobox", { name: "Command", exact: true });
      await cmdline.waitFor();
      await cmdline.fill(line);
      await page.keyboard.press("Enter");
    },
  };
}
