// The Live Inventory on the whole stack, kept as a team's (a git repo with a remote): an edit, an
// add (its Login tested over ssh against a stand-in Host, after its host key is confirmed) and a
// remove each become a Pending change that serve writes to roster.yml, `:changes` shows the diff,
// and `:discard` takes roster.yml back to the last commit.
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpFailures, launch, openApp, type AppPage } from "./page";
import { HOST_ITEM, HOST_USER, MASTER_PASSWORD, startStack, type Stack } from "./stack";
import type { StandIn } from "./setup";

const oneHost = (s: Record<string, StandIn>) => `defaults:
  user: ${HOST_USER}
groups:
  lab:
    title: Lab
    hosts:
      lab-01:
        ip: 127.0.0.1
        ssh: {port: ${s["lab-01"]!.port}}
        auth: "bw:${HOST_ITEM}"
        enroll: false
`;

let browser: Browser;
let stack: Stack;
let app: AppPage;
let page: Page;
let committed: string;

beforeAll(async () => {
  browser = await launch();
  stack = await startStack({ inventory: oneHost, repo: true });
  committed = readFileSync(stack.inventory, "utf8");
  app = await openApp(browser, stack);
  page = app.page;
  await page.getByRole("dialog", { name: "Locked" }).getByLabel("Master password").fill(MASTER_PASSWORD);
  await page.keyboard.press("Enter");
  await row("lab-01").waitFor();
});
dumpFailures(() => app);
afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

function row(name: string) {
  return page.getByRole("group", { name: "Inventory" }).getByRole("treeitem", { name: new RegExp(`^${name},`) });
}
const onDisk = () => readFileSync(stack.inventory, "utf8");
const status = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text }).first();

async function pending(n: number) {
  await app.ex("changes");
  const panel = page.getByRole("region", { name: "Pending changes" });
  await panel.getByRole("heading", { name: `Pending changes · ${n}` }).waitFor();
  return panel;
}

describe("the Inventory's edits as Pending changes", () => {
  it(":edit saves a Host's new title to roster.yml, as a Pending change", async () => {
    await app.ex("edit lab-01");
    const edit = page.getByRole("region", { name: "Edit lab-01" });
    await edit.getByLabel("Title").fill("Lab box one");
    await page.keyboard.press("Enter");
    await status("Saved lab-01").waitFor();
    expect(onDisk()).toContain("title: Lab box one");
    const panel = await pending(1);
    expect(await panel.getByRole("listitem").allInnerTexts()).toEqual(["lab-01 title"]);
    expect(await panel.innerText()).toMatch(/\+\s*title: Lab box one/);
  });

  it(":discard takes roster.yml back to the last commit", async () => {
    await app.ex("discard");
    await page.getByRole("alertdialog", { name: "Discard the Pending changes?" }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("alertdialog", { name: "Discard the Pending changes?" }).waitFor({ state: "detached" });
    await expect.poll(onDisk).toBe(committed);
  });

  it("the add form tests the Login over ssh, then adds the Host", async () => {
    await app.ex("host add");
    const add = page.getByRole("region", { name: "Add a Host" });
    await add.getByLabel("Name").fill("lab-02");
    await add.getByLabel("Address").fill("127.0.0.1");
    await add.getByLabel("Port").fill(String(stack.standIns["lab-02"]!.port));
    await add.getByLabel("User").fill(HOST_USER);
    await add.getByRole("radio", { name: "An existing vault item" }).check();
    await add.getByRole("combobox", { name: "Vault item" }).fill(`bw:${HOST_ITEM}`);
    await add.getByRole("button", { name: "Test login and add" }).click();
    await add.getByRole("group", { name: "Confirm the host key" }).getByRole("button", { name: "Trust it and add" }).waitFor();
    await page.keyboard.press("Enter");
    await status("Added lab-02 to lab").waitFor();
    await row("lab-02").waitFor();
    expect(await row("lab-02").getAttribute("aria-label")).toContain("not Published yet");
    expect(onDisk()).toContain("lab-02:");
  });

  it(":host remove asks, then takes the Host out of roster.yml", async () => {
    await app.ex("host remove lab-01");
    const ask = page.getByRole("alertdialog", { name: "Remove lab-01?" });
    await ask.waitFor();
    await page.keyboard.press("Enter");
    await row("lab-01").waitFor({ state: "detached" });
    expect(onDisk()).not.toContain("lab-01:");
    const panel = await pending(2);
    expect((await panel.getByRole("listitem").allInnerTexts()).join("\n")).toMatch(/lab-02[\s\S]*lab-01|lab-01[\s\S]*lab-02/);
  });

  it(":discard drops both, and the Sidebar follows roster.yml back", async () => {
    await app.ex("discard");
    await page.getByRole("alertdialog", { name: "Discard the Pending changes?" }).waitFor();
    await page.keyboard.press("Enter");
    await expect.poll(onDisk).toBe(committed);
    await row("lab-01").waitFor();
    await row("lab-02").waitFor({ state: "detached" });
  });
});
