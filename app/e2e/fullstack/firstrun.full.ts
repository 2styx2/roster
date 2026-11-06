// The first run on the whole stack: a Box with no roster.yml shows "Start your Inventory"
// (FirstRun), serve makes one (`inventory.create`), the app connects again on it, a Host added
// through the form lands in it, and the Sidebar and the Picker list it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpFailures, launch, openApp, type AppPage } from "./page";
import { HOST_USER, startStack, type Stack } from "./stack";

let browser: Browser;
let stack: Stack;
let app: AppPage;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  stack = await startStack();
  app = await openApp(browser, stack);
  page = app.page;
});
dumpFailures(() => app);
afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

const made = () => join(stack.home, "infra", "roster.yml");

describe("the first run", () => {
  it("offers to start an Inventory when the Box has none", async () => {
    const start = page.getByRole("region", { name: "Start your Inventory" });
    await start.waitFor();
    expect(await start.getByRole("radio", { name: /^A blank one/ }).isChecked()).toBe(true);
    expect(await start.getByLabel("Folder").inputValue()).toBe("~/infra");
    expect(existsSync(made())).toBe(false);
  });

  it("serve makes a blank one, and the app opens on it", async () => {
    await page.getByRole("button", { name: "Make it" }).click();
    await page.getByRole("status").filter({ hasText: `Made ${made()}` }).waitFor();
    await page.getByRole("group", { name: "Inventory" }).getByRole("treeitem", { name: /^Inventory/ }).waitFor();
    expect(readFileSync(made(), "utf8").length).toBeGreaterThan(0);
  });

  it("a Host added through the form is in roster.yml, the Sidebar and the Picker", async () => {
    await page.getByRole("toolbar", { name: "Commands" }).getByRole("button", { name: "Add a Host" }).click();
    const add = page.getByRole("region", { name: "Add a Host" });
    await add.getByLabel("Name").fill("lab-01");
    await add.getByLabel("Address").fill("127.0.0.1");
    await add.getByLabel("Port").fill(String(stack.standIns["lab-01"]!.port));
    await add.getByLabel("User").fill(HOST_USER);
    await add.getByRole("radio", { name: "No Login yet" }).check();
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: /^Added lab-01/ }).first().waitFor();
    await page.getByRole("group", { name: "Inventory" }).getByRole("treeitem", { name: /^lab-01,/ }).waitFor();
    expect(readFileSync(made(), "utf8")).toContain("lab-01:");
    await page.keyboard.press("Control+Space");
    await page.keyboard.press("f");
    await page.getByRole("combobox", { name: /Find a Host/ }).fill("lab");
    await page.getByRole("listbox", { name: "Hosts" }).getByRole("option", { name: /^lab-01 127\.0\.0\.1/ }).waitFor();
    await page.keyboard.press("Escape");
  });
});
