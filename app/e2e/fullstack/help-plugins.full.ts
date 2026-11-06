// :help, a first-party Plugin and :tutor on the whole stack: `:help TOPIC` opens its page at the
// entry; the Topology Plugin installs from its folder after the permission prompt, runs in the
// core's Plugin host and draws its view from serve's Hosts; `:tutor` swaps in the demo Inventory
// on the core's demo Plugin host and `:tutor quit` comes back, leaving a password typed in the
// real workspace as it was.
import { resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpFailures, launch, openApp, type AppPage } from "./page";
import { MASTER_PASSWORD, labInventory, startStack, type Stack } from "./stack";

const TOPOLOGY = resolve(import.meta.dirname, "../../../plugins/topology");
/** A password typed in the real workspace's add form (made up; it never leaves the page). */
const TYPED = "typed-e2e-pass-9";

let browser: Browser;
let stack: Stack;
let app: AppPage;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  stack = await startStack({ inventory: labInventory });
  app = await openApp(browser, stack);
  page = app.page;
  await page.getByRole("dialog", { name: "Locked" }).getByLabel("Master password").fill(MASTER_PASSWORD);
  await page.keyboard.press("Enter");
  await page.getByRole("group", { name: "Inventory" }).getByRole("treeitem", { name: /^lab-01,/ }).waitFor();
});
dumpFailures(() => app);
afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

describe(":help, a Plugin, :tutor", () => {
  it(":help TOPIC opens the page at its entry", async () => {
    await app.ex("help terminal.size");
    const help = page.getByRole("complementary", { name: "Help" });
    await help.getByRole("heading", { name: "Options", level: 1 }).waitFor();
    // The entry the topic names, marked as the target and scrolled into view.
    const entry = help.locator('.help-target[data-tag="terminal.size"]');
    await entry.waitFor();
    await expect.poll(() => entry.evaluate((h) => {
      const r = h.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    })).toBe(true);
    await help.getByRole("button", { name: "Close help" }).click();
    await help.waitFor({ state: "detached" });
  });

  it("the Topology Plugin installs after its prompt and draws serve's Hosts", async () => {
    await app.ex(`plugins install ${TOPOLOGY}`);
    const ask = page.getByRole("alertdialog", { name: "Install topology?" });
    await ask.waitFor();
    expect(await ask.getByRole("listitem").count()).toBe(6);
    // The prompt opens on Cancel: Shift+Tab, then Enter installs.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await ask.waitFor({ state: "detached" });
    // Loaded once its command is one the command line completes.
    await page.keyboard.press("Control+Space");
    await page.keyboard.press(":");
    await page.keyboard.type("topolog");
    await page.getByRole("listbox", { name: "Completions" }).getByRole("option", { name: /^topology/ }).first().waitFor();
    await page.keyboard.press("Escape");
    await app.ex("topology");
    const view = page.getByRole("region", { name: "Topology (from topology)" });
    await view.getByText("2 Hosts in 1 group.").waitFor();
    await view.getByRole("status").filter({ hasText: /^This Box, box, square/ }).waitFor();
    const canvas = await view.locator("canvas").first().boundingBox();
    expect(canvas?.width ?? 0).toBeGreaterThan(100);
    await page.keyboard.press("Escape");
    await view.waitFor({ state: "detached" });
  });

  it(":tutor shows the demo Inventory, :tutor quit comes back, a typed password stays", async () => {
    await app.ex("host add");
    const add = page.getByRole("region", { name: "Add a Host" });
    await add.getByRole("radio", { name: "Type its password" }).check();
    await add.getByLabel("Password", { exact: true }).fill(TYPED);
    await app.ex("tutor");
    const demo = page.getByRole("region", { name: "Demo Inventory" });
    await demo.waitFor();
    await page.getByRole("group", { name: "Inventory" }).getByRole("treeitem", { name: /^demo-01,/ }).waitFor();
    await app.ex("tutor quit");
    await demo.waitFor({ state: "detached" });
    await page.getByRole("group", { name: "Inventory" }).getByRole("treeitem", { name: /^lab-01,/ }).waitFor();
    expect(await page.getByRole("region", { name: "Add a Host" }).getByLabel("Password", { exact: true }).inputValue()).toBe(TYPED);
  });
});
