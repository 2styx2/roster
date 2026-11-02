// Ticket 10 through the App with the fake Backend: `:edit` opens the form (its pull: App.pull.test.tsx), a text
// edit saves as a Pending change, an address/user/Login edit tests the login first (decision Q43),
// the status bar counts the Pending changes, and `:changes` shows the diff and discards it.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import { EditError, VERIFY_STEPS } from "./backend/types";
import { changesOf, draftOf, needsVerify } from "./edit/form";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const HOST = "linux-1-000";

async function ready(scenario: FakeScenario = fixtures.edit as FakeScenario) {
  const user = userEvent.setup();
  const backend = fakeBackend(scenario);
  render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend };
}

const form = () => screen.findByRole("region", { name: `Edit ${HOST}` });
const statusbar = () => document.querySelector(".statusbar") as HTMLElement;

describe("the edit form", () => {
  it("pulls, then opens with the Host's fields and the first one focused", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await form();
    expect(await within(panel).findByText("Up to date with origin/main.")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Title")).toHaveFocus();
    expect(within(panel).getByLabelText("Address")).toHaveValue("10.19.1.2");
    expect(within(panel).getByLabelText("User")).toHaveValue("admin");
    expect(within(panel).getByRole("button", { name: "Save" })).toBeDisabled();       // nothing changed yet
  });

  it("saves a text edit with Enter, without a test login, and counts it in the status bar", async () => {
    const { user, backend } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    expect(statusbar()).not.toHaveTextContent(/Pending change/);
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await form();
    const title = await within(panel).findByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Build box");
    expect(within(panel).getByText(/· changed/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Save" })).toBeEnabled();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/Saved linux-1-000 as a Pending change/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: `Edit ${HOST}` })).toBeNull();
    expect((await backend.getHost(HOST)).title).toBe("Build box");
    expect(await within(statusbar()).findByRole("button", { name: /1 Pending change/ })).toBeInTheDocument();
  });

  it("tests the login before saving a new user, and saves only if it passed", async () => {
    const failing = {
      host: HOST,
      ok: false,
      steps: VERIFY_STEPS.map((step) =>
        step === "auth"
          ? { step, status: "fail" as const, code: 45, message: `${HOST} refused the password for user root`, fix: "check the user" }
          : { step, status: "ok" as const, message: "fine" },
      ),
    };
    const { user, backend } = await ready({ ...(fixtures.edit as FakeScenario), verifyResults: { [HOST]: failing } });
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await form();
    const userField = await within(panel).findByLabelText("User");
    await user.clear(userField);
    await user.type(userField, "root");
    expect(within(panel).getByText(/roster tests the login first/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Test login and save" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("The test login failed, so nothing was saved.");
    expect(alert).toHaveTextContent("refused the password for user root");
    expect((await backend.getHost(HOST)).ssh.user).toBe("admin");
    expect((await backend.pendingChanges()).count).toBe(0);
  });

  it("saves a new address once the test login passed", async () => {
    const { user, backend } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await form();
    const ip = await within(panel).findByLabelText("Address");
    await user.clear(ip);
    await user.type(ip, "10.19.1.99{Enter}");
    expect(await screen.findByText(/Saved linux-1-000 as a Pending change/)).toBeInTheDocument();
    expect((await backend.getHost(HOST)).ip).toBe("10.19.1.99");
  });

  it("refuses a bad port before asking roster", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await form();
    const port = await within(panel).findByLabelText("Port");
    await user.clear(port);
    await user.type(port, "99999");
    expect(port).toHaveAttribute("aria-invalid", "true");
    expect(within(panel).getByText("A number from 1 to 65535")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Test login and save" })).toBeDisabled();
  });

  it("doesn't pull over Pending changes already here", async () => {
    const { user } = await ready(fixtures["edit-pending"] as FakeScenario);
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await form();
    expect(within(panel).getByText(/didn't pull/)).toBeInTheDocument();
    expect(within(panel).getByLabelText("Title")).toHaveValue("Build box");
  });

  it("edits the current Session's Host with ␣ E, and Esc closes it", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:connect ${HOST}{Enter}`);
    await user.keyboard(`${LEADER}E`);
    const panel = await form();
    expect(await within(panel).findByLabelText("Title")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: `Edit ${HOST}` })).toBeNull();
  });

  it("needs a roster that speaks API 5", async () => {
    const { user } = await ready({ ...(fixtures.edit as FakeScenario), apiVersion: 4 });
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    expect(await screen.findByText(/:edit needs a newer roster \(API version 5; this one speaks 4\)/)).toBeInTheDocument();
  });
});

describe("Pending changes", () => {
  it("counts them in the status bar, which opens the diff", async () => {
    const { user } = await ready(fixtures["edit-pending"] as FakeScenario);
    const count = await within(statusbar()).findByRole("button", { name: /2 Pending changes/ });
    await user.click(count);
    const panel = await screen.findByRole("region", { name: "Pending changes" });
    expect(panel).toHaveTextContent("Pending changes · 2");
    expect(within(panel).getByText("linux-1-000").closest("li")).toHaveTextContent("title, description");
    const diff = within(panel).getByLabelText("The diff of roster.yml");
    const added = [...diff.querySelectorAll(".diff-line.add")].map((l) => l.textContent);
    const removed = [...diff.querySelectorAll(".diff-line.del")].map((l) => l.textContent);
    expect(added).toContain("added: +        title: Build box\n");
    expect(removed.some((l) => l?.includes("type: esxi"))).toBe(true);
  });

  it(":discard asks first, and Enter discards them", async () => {
    const { user, backend } = await ready(fixtures["edit-pending"] as FakeScenario);
    await within(statusbar()).findByRole("button", { name: /2 Pending changes/ });
    await user.keyboard(`${LEADER}:discard{Enter}`);
    const question = await screen.findByRole("alertdialog", { name: "Discard the Pending changes?" });
    expect(question).toHaveTextContent("Discard 2 Pending changes?");
    expect(within(question).getByRole("button", { name: "Discard" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/Discarded the Pending changes/)).toBeInTheDocument();
    expect((await backend.pendingChanges()).count).toBe(0);
    expect((await backend.getHost(HOST)).title).not.toBe("Build box");
    expect(statusbar()).not.toHaveTextContent(/Pending change/);
  });

  it(":discard asks even when the panel is already open", async () => {
    const { user } = await ready(fixtures["edit-pending"] as FakeScenario);
    await user.click(await within(statusbar()).findByRole("button", { name: /2 Pending changes/ }));
    await screen.findByRole("region", { name: "Pending changes" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const diff = screen.getByLabelText("The diff of roster.yml");
    expect(diff).not.toHaveTextContent("diff --git");
    await user.keyboard(`${LEADER}:discard{Enter}`);
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("Esc backs out of the question, then closes the panel", async () => {
    const { user, backend } = await ready(fixtures["edit-pending"] as FakeScenario);
    await within(statusbar()).findByRole("button", { name: /2 Pending changes/ });
    await user.keyboard(`${LEADER}:discard{Enter}`);
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull();
    expect((await backend.pendingChanges()).count).toBe(2);
  });

  it("says there are none, with the key that edits", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}c`);
    const panel = await screen.findByRole("region", { name: "Pending changes" });
    expect(await within(panel).findByText(/No Pending changes/)).toBeInTheDocument();
    expect(panel.querySelector(".keys")).not.toBeNull();
  });
});

describe("the fake Backend keeps roster's rules", () => {
  it("refuses an unverified address change and a pull over Pending changes", async () => {
    const backend = fakeBackend(fixtures.edit as FakeScenario);
    await expect(backend.updateHost(HOST, { ip: "10.0.0.1" })).rejects.toMatchObject({ code: EditError.notVerified });
    await backend.updateHost(HOST, { title: "x" });
    await expect(backend.pullInventory()).rejects.toMatchObject({ code: EditError.dirty });
  });
});

describe("the form's logic", () => {
  const h = (fixtures.edit as FakeScenario).hosts.hosts[0];
  it("sends only what changed, text collapsed to one line, and knows what needs a test login", () => {
    if (!h) throw new Error("no host");
    const d = draftOf(h);
    expect(changesOf(h, d)).toEqual({});
    expect(changesOf(h, { ...d, title: "  Big   box " })).toEqual({ title: "Big box" });
    expect(changesOf(h, { ...d, port: "2222" })).toEqual({ port: 2222 });
    expect(changesOf(h, { ...d, ip: "" })).toBeNull();
    expect(needsVerify({ title: "x" })).toBe(false);
    expect(needsVerify({ auth: "bw:x" })).toBe(true);
  });
});
