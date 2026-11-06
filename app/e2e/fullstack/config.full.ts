// init.lua on the whole stack: the file on disk is edited (written, as an editor saves it), the
// core's watcher reads it and sends `config-changed`, and the running app shows the change: the
// Theme's colours, the terminal's font size and cursor in an open Session (which keeps running),
// a rebound key, the layout's pieces, a panel's width, a Theme defined in Lua, Folders handed to
// the built-in Plugin. A Lua error or a value out of bounds shows in the Config toast with its
// line while the last good Config stays in effect, and fixing the file clears it. With
// auto_reload off a save is only `config-stale`, and `:source` or `:config reload` apply it.
// Every step waits for the bridge's event, never for a while.
import { writeFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpFailures, launch, openApp, type AppPage } from "./page";
import { MASTER_PASSWORD, labInventory, startStack, type Stack } from "./stack";

interface Report {
  config: Record<string, unknown>;
  error: { message: string; line?: number | null } | null;
}

const BASE = `roster.o.terminal.renderer = "dom"\nroster.o.auto_reload = true\n`;

let browser: Browser;
let stack: Stack;
let app: AppPage;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  stack = await startStack({ inventory: labInventory, initLua: BASE });
  app = await openApp(browser, stack);
  page = app.page;
  await page.getByRole("dialog", { name: "Locked" }).getByLabel("Master password").fill(MASTER_PASSWORD);
  await page.keyboard.press("Enter");
  await page.getByRole("group", { name: "Inventory" }).getByRole("treeitem", { name: /^lab-01,/ }).waitFor();
  await app.ex("connect lab-01");
  await page.getByRole("alertdialog", { name: "Trust lab-01's host key?" }).waitFor();
  // The question opens on Cancel (owner, Q234 g): Shift+Tab to Trust and connect, then Enter.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await app.terminalShows(/^lab-01:~\$$/m);
});
dumpFailures(() => app);
afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

/** Writes init.lua as BASE + `lua` and waits for the reload it causes; gives its report. */
async function save(lua: string): Promise<Report> {
  const n = await app.eventCount("config-changed");
  writeFileSync(stack.initLua, BASE + lua);
  return app.nextEvent<Report>("config-changed", n);
}

/** The Theme's colour tokens as the page has them on :root. */
const tokens = () =>
  page.evaluate(() => {
    const s = document.documentElement.style;
    return Object.fromEntries([...Array(s.length).keys()].map((i) => s.item(i)).filter((n) => n.startsWith("--")).map((n) => [n, s.getPropertyValue(n).trim()]));
  });

/** The visible terminal's font size in px, and its cursor's style class. */
const terminalLook = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".xterm-rows")].find((r) => r.offsetParent !== null);
    const cursor = rows?.querySelector(".xterm-cursor");
    return {
      size: rows ? parseFloat(getComputedStyle(rows).fontSize) : null,
      cursor: [...(cursor?.classList ?? [])].find((c) => /^xterm-cursor-(block|bar|underline)$/.test(c)) ?? null,
    };
  });

async function shellStillAnswers(word: string) {
  await page.locator(".xterm-screen").filter({ visible: true }).click();
  await page.keyboard.type(`echo ${word}\n`);
  await app.terminalShows(new RegExp(`^${word}$`, "m"));
}

const toast = () => page.getByRole("alert", { name: "Config problem" });

describe("init.lua edits on disk take effect", () => {
  it("a Theme: its colour tokens change", async () => {
    expect((await save(`roster.o.theme = "roster-light"\n`)).error).toBeNull();
    const light = await tokens();
    expect((await save(`roster.o.theme = "roster-dark"\n`)).error).toBeNull();
    const dark = await tokens();
    expect(Object.keys(light).length).toBeGreaterThan(5);
    expect(dark).not.toEqual(light);
  });

  it("a Theme defined in Lua, and chosen", async () => {
    const r = await save(
      `roster.themes.define("e2e-paper", { label = "E2E paper", base = "roster-light", colors = { accent = "#3a6ee0", bg = "#fbfaf7" } })\nroster.o.theme = "e2e-paper"\n`,
    );
    expect(r.error).toBeNull();
    const t = Object.values(await tokens()).map((v) => v.toLowerCase());
    expect(t).toContain("#3a6ee0");
    expect(t).toContain("#fbfaf7");
  });

  it("the terminal's size and cursor, in the open Session, which keeps running", async () => {
    const before = await terminalLook();
    expect((await save(`roster.o.terminal.size = 24\nroster.o.terminal.cursor_style = "underline"\n`)).error).toBeNull();
    await expect.poll(terminalLook).toEqual({ size: 24, cursor: "xterm-cursor-underline" });
    expect(before.size).not.toBe(24);
    await shellStillAnswers("after-reload");
    expect((await save(`roster.o.terminal.size = 15\nroster.o.terminal.cursor_style = "bar"\n`)).error).toBeNull();
    await expect.poll(terminalLook).toEqual({ size: 15, cursor: "xterm-cursor-bar" });
  });

  it("a key rebound: the new key runs the command, the old one doesn't, the hints say the new one", async () => {
    expect((await save(`roster.keymap.set("leader", "o", "find")\nroster.keymap.set("leader", "f", false)\n`)).error).toBeNull();
    const status = page.getByRole("contentinfo");
    await expect.poll(() => status.innerText()).toMatch(/o\s*find/);
    expect(await status.innerText()).not.toMatch(/f\s*find/);
    const picker = page.getByRole("dialog", { name: "Find a Host" });
    await page.keyboard.press("Control+Space");
    await page.keyboard.press("f");
    // Leader f did nothing: the next frame after the key has no Picker in it.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(await picker.count()).toBe(0);
    await page.keyboard.press("Control+Space");
    await page.keyboard.press("o");
    await picker.waitFor();
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached" });
  });

  it("the layout: the status bar off, the Sidebar on the right", async () => {
    expect((await save(`roster.o.modes.standard.statusbar = false\nroster.o.modes.standard.sidebar = { side = "right" }\n`)).error).toBeNull();
    await page.getByRole("contentinfo").waitFor({ state: "detached" });
    await expect.poll(async () => (await page.getByRole("navigation", { name: "Sidebar" }).boundingBox())?.x ?? 0).toBeGreaterThan(640);
    expect((await save("")).error).toBeNull();
    await page.getByRole("contentinfo").waitFor();
    await expect.poll(async () => (await page.getByRole("navigation", { name: "Sidebar" }).boundingBox())?.x ?? 999).toBeLessThan(10);
  });

  // 30%: inside the bounds the panel keeps (at least 280 px, and room for about 50 columns of terminal).
  it("panel.width: a docked panel takes that share of the window", async () => {
    expect((await save(`roster.o.panel.width = 30\n`)).error).toBeNull();
    await page.keyboard.press("Control+Space");
    await page.keyboard.press("Shift+K");
    const keys = page.getByRole("complementary", { name: "Key bindings" });
    await keys.waitFor();
    await expect.poll(async () => Math.round(((await keys.boundingBox())?.width ?? 0) / 12.8)).toBe(30);
    await page.keyboard.press("Escape");
    await keys.waitFor({ state: "detached" });
  });

  it("Folders in init.lua reach the built-in Folders Plugin, and show in the Sidebar", async () => {
    expect((await save(`roster.folders.add({ name = "Lab pair", hosts = { "lab-01", "lab-02" } })\n`)).error).toBeNull();
    await page.getByRole("group", { name: "Folders" }).getByRole("treeitem", { name: /^Lab pair/ }).waitFor();
  });
});

describe("a broken init.lua keeps the last good Config", () => {
  it("a Lua syntax error: the toast names its line, the old values stay, a fix clears it", async () => {
    expect((await save(`roster.o.terminal.size = 22\n`)).error).toBeNull();
    await expect.poll(async () => (await terminalLook()).size).toBe(22);
    const r = await save(`roster.o.terminal.size = 18\nroster.o.theme = = "roster-light"\n`);
    expect(r.error).not.toBeNull();
    await toast().waitFor();
    expect(await toast().innerText()).toMatch(/init\.lua:4/);
    expect((await terminalLook()).size).toBe(22);
    await shellStillAnswers("still-22");
    expect((await save(`roster.o.terminal.size = 18\n`)).error).toBeNull();
    await toast().waitFor({ state: "detached" });
    await expect.poll(async () => (await terminalLook()).size).toBe(18);
  });

  it("a value out of bounds: the toast names it and its line, the old value stays", async () => {
    const r = await save(`roster.o.terminal.size = 18\nroster.o.panel.width = 5\n`);
    expect(r.error).not.toBeNull();
    await toast().waitFor();
    expect(await toast().innerText()).toMatch(/panel\.width/);
    expect(await toast().innerText()).toMatch(/init\.lua:4/);
    expect((await terminalLook()).size).toBe(18);
    expect((await save(`roster.o.terminal.size = 18\n`)).error).toBeNull();
    await toast().waitFor({ state: "detached" });
  });
});

describe("with auto_reload off, a save waits for :source", () => {
  it("a save is only config-stale; :source applies it", async () => {
    expect((await save(`roster.o.auto_reload = false\nroster.o.terminal.size = 18\n`)).error).toBeNull();
    const stale = await app.eventCount("config-stale");
    const changed = await app.eventCount("config-changed");
    writeFileSync(stack.initLua, `${BASE}roster.o.auto_reload = false\nroster.o.terminal.size = 20\n`);
    await app.nextEvent("config-stale", stale);
    expect(await app.eventCount("config-changed")).toBe(changed);
    expect((await terminalLook()).size).toBe(18);
    await app.ex("source");
    const r = await app.nextEvent<Report>("config-changed", changed);
    expect(r.error).toBeNull();
    await expect.poll(async () => (await terminalLook()).size).toBe(20);
  });

  it(":config reload does the same", async () => {
    const stale = await app.eventCount("config-stale");
    const changed = await app.eventCount("config-changed");
    writeFileSync(stack.initLua, `${BASE}roster.o.auto_reload = false\nroster.o.terminal.size = 16\n`);
    await app.nextEvent("config-stale", stale);
    await app.ex("config reload");
    expect((await app.nextEvent<Report>("config-changed", changed)).error).toBeNull();
    await expect.poll(async () => (await terminalLook()).size).toBe(16);
    await shellStillAnswers("still-here");
  });
});
