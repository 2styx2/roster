// A roster.yml roster won't name (T261, #529): since API 31 serve sends "(not repeated)" for the path of
// one in a folder (or with a name) that looks like a token, in inventory.info, inventories.list,
// inventory.watch and changes.diff. The app says so where it named the file, with the rename hint,
// and never offers the words as a path.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { sinceOf } from "./backend/capabilities";
import { FAKE_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "./backend/fake";
import { PATH_NOT_REPEATED } from "./backend/serveContract";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const HINT = "Rename the folder (or file) whose name looks like a token, then give roster its new path.";

const hidden = (more: Partial<FakeScenario> = {}): FakeScenario => ({
  hosts: makeHosts(6),
  apiVersion: sinceOf("hiddenPaths"),
  info: { path: PATH_NOT_REPEATED },
  ...more,
});

async function ready(s: FakeScenario) {
  const user = userEvent.setup();
  render(<App backend={fakeBackend(s)} terminalView={StubTerminal} platform={memoryPlatform()} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const statusbar = () => document.querySelector(".statusbar") as HTMLElement;

describe("a roster.yml roster won't name", () => {
  it("is said so in the status bar, with what to do in its tooltip", async () => {
    await ready(hidden());
    const path = statusbar().querySelector(".path") as HTMLElement;
    expect(path).toHaveTextContent("roster.yml (not repeated)");
    expect(path.title).toContain(`the roster.yml at that path (not repeated). ${HINT}`);
  });

  it("is said so by :changes, with the rename hint", async () => {
    const user = await ready(hidden({ pending: { "linux-1-000": { title: "Build box" } } }));
    await user.keyboard(`${LEADER}:changes{Enter}`);
    const panel = await screen.findByRole("region", { name: "Pending changes" });
    expect(panel).toHaveTextContent(`Edits on this Box that aren't Published yet, in the roster.yml at that path (not repeated). ${HINT}`);
    expect(within(panel).queryByText(PATH_NOT_REPEATED, { selector: "code" })).toBeNull();
  });

  it("is said so by :publish on a plain file", async () => {
    const user = await ready(hidden({ store: "file" }));
    await user.keyboard(`${LEADER}:publish{Enter}`);
    expect(
      await screen.findByText(`roster.yml is a plain file (that path (not repeated)): every edit is saved straight to it, so there are no Pending changes to show, discard or publish. ${HINT}`, {
        selector: ".message-line",
      }),
    ).toBeInTheDocument();
  });

  it("is said so where there are no Hosts yet", async () => {
    await ready(hidden({ hosts: { hosts: [], groups: {} } }));
    expect(await screen.findByText(/Add them to the roster\.yml at that path \(not repeated\) and they show up here/)).toBeInTheDocument();
    expect(screen.getByText(HINT, { exact: false })).toBeInTheDocument();
  });

  it("is said so in the named Inventory's tooltip and :inventory's answers", async () => {
    const user = await ready(
      hidden({
        inventories: { named: [{ name: "work", path: PATH_NOT_REPEATED }, { name: "home", path: "/home/you/home-lab/roster.yml" }], active: "work" },
      }),
    );
    expect(await within(statusbar()).findByTitle(`Inventory work: the roster.yml at that path (not repeated). ${HINT}`)).toHaveTextContent("work");
    await user.keyboard(`${LEADER}:inventory work{Enter}`);
    expect(await screen.findByText(`Already on work (that path (not repeated)). ${HINT}`, { selector: ".message-line" })).toBeInTheDocument();
  });

  it("is said so for another named Inventory's roster.yml (#538, API 32)", async () => {
    const user = await ready(
      hidden({
        apiVersion: sinceOf("hiddenNamedPaths"),
        inventories: { named: [{ name: "home", path: "/home/you/home-lab/roster.yml" }, { name: "lab", path: PATH_NOT_REPEATED, exists: false }], active: "home" },
        info: { path: "/home/you/home-lab/roster.yml" },
      }),
    );
    await user.keyboard(`${LEADER}:inventory lab{Enter}`);
    expect(
      await screen.findByText(`lab's roster.yml isn't there: that path (not repeated). roster inv remove lab forgets it. ${HINT}`, { selector: ".message-line" }),
    ).toBeInTheDocument();
  });

  it("is shown as it is by a roster before API 32, which never hides a named Inventory's", async () => {
    const user = await ready(
      hidden({
        apiVersion: sinceOf("hiddenNamedPaths") - 1,
        inventories: { named: [{ name: "home", path: "/home/you/home-lab/roster.yml" }, { name: "lab", path: PATH_NOT_REPEATED, exists: false }], active: "home" },
        info: { path: "/home/you/home-lab/roster.yml" },
      }),
    );
    await user.keyboard(`${LEADER}:inventory lab{Enter}`);
    expect(
      await screen.findByText(`lab's roster.yml isn't there: ${PATH_NOT_REPEATED}. roster inv remove lab forgets it`, { selector: ".message-line" }),
    ).toBeInTheDocument();
  });

  it("is shown as it is by a roster before API 31, which never hides one", async () => {
    await ready(hidden({ apiVersion: sinceOf("hiddenPaths") - 1 }));
    expect(statusbar().querySelector(".path")?.textContent).toBe(PATH_NOT_REPEATED);
  });
});
