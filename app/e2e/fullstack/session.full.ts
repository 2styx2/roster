// Sessions on the whole stack: the vault's unlock screen, the Sidebar and the Picker over serve's
// Hosts, a Session to a stand-in Host (a real PTY and ssh, its password from the fake vault
// through serve's askpass), sudo's prompt filled by the core, `:check HOST` with serve's progress,
// Quick Connect, and `:lock`. No password ever reaches the page, its console or the core's logs.
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpFailures, launch, openApp, type AppPage } from "./page";
import { HOST_PASSWORD, HOST_USER, MASTER_PASSWORD, labInventory, startStack, type Stack } from "./stack";

let browser: Browser;
let stack: Stack;
let app: AppPage;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  stack = await startStack({ inventory: labInventory });
  app = await openApp(browser, stack);
  page = app.page;
});
dumpFailures(() => app);
afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

/** No secret anywhere the frontend or a log could keep it. */
async function noSecretsAnywhere() {
  const seen = [await app.everything(), app.logs.join("\n"), stack.stderr()].join("\n");
  expect(seen).not.toContain(HOST_PASSWORD);
  expect(seen).not.toContain(MASTER_PASSWORD);
}

async function leader(key: string) {
  await page.keyboard.press("Control+Space");
  await page.keyboard.press(key);
}

const inventoryRow = (name: string) => page.getByRole("group", { name: "Inventory" }).getByRole("treeitem", { name: new RegExp(`^${name},`) });

describe("a Session on the whole stack", () => {
  it("unlocks the vault, and the Sidebar lists serve's Hosts", async () => {
    const locked = page.getByRole("dialog", { name: "Locked" });
    await locked.getByLabel("Master password").fill(MASTER_PASSWORD);
    await page.keyboard.press("Enter");
    await inventoryRow("lab-01").waitFor();
    await inventoryRow("lab-02").waitFor();
    expect(await locked.count()).toBe(0);
    await noSecretsAnywhere();
  });

  it("finds a Host in the Picker", async () => {
    await leader("f");
    const query = page.getByRole("combobox", { name: /Find a Host/ });
    await query.fill("lab-0");
    await expect.poll(() => page.getByRole("listbox", { name: "Hosts" }).getByRole("option").count()).toBe(2);
    await query.fill("lab-01");
    await expect.poll(() => page.getByRole("listbox", { name: "Hosts" }).getByRole("option").count()).toBe(1);
  });

  it("opens a Session over ssh once the host key is trusted, and the shell answers", async () => {
    await page.keyboard.press("Enter");
    const trust = page.getByRole("alertdialog", { name: "Trust lab-01's host key?" });
    await trust.waitFor();
    await page.keyboard.press("Enter");
    await app.terminalShows(/^lab-01:~\$$/m);
    await page.keyboard.type("hostname\n");
    await app.terminalShows(/^lab-01$/m);
    await noSecretsAnywhere();
  });

  it("fills sudo's prompt from the vault, in the core, never through the page", async () => {
    await page.keyboard.type("sudo -k; sudo id -un\n");
    await app.terminalShows(`[sudo] password for ${HOST_USER}:`);
    await leader("p");
    await app.terminalShows(/^root$/m);
    await noSecretsAnywhere();
  });

  it(":check HOST runs serve's job, with its progress, through to the login", async () => {
    const notes = await app.eventCount("roster-notification");
    await app.ex("check lab-01");
    const check = page.getByRole("region", { name: "Check lab-01" });
    await check.getByText("All checks passed.").waitFor();
    const steps = await check.getByRole("list").ariaSnapshot();
    expect(steps).toContain("passed: Host key matches the recorded ssh-ed25519 key");
    expect(steps).toContain(`passed: Login logged in as ${HOST_USER}`);
    expect(steps).not.toContain("failed:");
    const progress = await page.evaluate(
      (n) => (window as unknown as { e2eEvents: { event: string; payload: { method: string } }[] }).e2eEvents.filter((e) => e.event === "roster-notification").slice(n).filter((e) => e.payload.method === "job.progress").length,
      notes,
    );
    expect(progress).toBeGreaterThan(0);
    await check.getByRole("button", { name: "Close the check" }).click();
    await check.waitFor({ state: "detached" });
  });

  it("Quick Connects to user@address:port with a typed password", async () => {
    const to = `${HOST_USER}@127.0.0.1:${stack.standIns["lab-02"]!.port}`;
    await leader("f");
    await page.getByRole("combobox", { name: /Find a Host/ }).fill(to);
    await page.getByRole("option", { name: new RegExp(`^Quick Connect ${to}`) }).waitFor();
    await page.keyboard.press("Enter");
    const ask = page.getByRole("alertdialog", { name: `Quick Connect to ${to}` });
    await ask.getByLabel(`Password for ${HOST_USER}`).fill(HOST_PASSWORD);
    await page.keyboard.press("Enter");
    await ask.waitFor({ state: "detached" });
    await app.terminalShows(/^lab-02:~\$$/m);
    await page.keyboard.type("hostname\n");
    await app.terminalShows(/^lab-02$/m);
    // The typed password went to serve once; nothing in the page keeps it.
    await noSecretsAnywhere();
  });

  it(":lock locks the vault, and the Sessions keep running behind it", async () => {
    await app.ex("lock");
    const locked = page.getByRole("dialog", { name: "Locked" });
    await locked.getByLabel("Master password").fill(MASTER_PASSWORD);
    await page.keyboard.press("Enter");
    await locked.waitFor({ state: "detached" });
    await page.getByRole("group", { name: "Sessions" }).getByRole("treeitem", { name: /^lab-01/ }).waitFor();
    await page.getByRole("group", { name: "Sessions" }).getByRole("treeitem", { name: /^lab-01/ }).click();
    await app.terminalShows(/^root$/m);
    await page.keyboard.type("echo still-here\n");
    await app.terminalShows(/^still-here$/m);
    await noSecretsAnywhere();
  });
});
