// Decision Q88 (ticket 69) through the App with the fake Backend: a form opens at once from the
// Inventory the app has, pulls the infra repo in the background only when the last good pull is
// older than `pull_fresh_minutes`, says so when that pull changed the Host it shows (keeping what
// you typed), and a pull that fails still blocks the save.
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, makeHosts, type FakeScenario } from "./backend/fake";
import type { Backend } from "./backend/types";
import { defaultOptions } from "./keymap";
import { manualClock } from "./lock/manualClock";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const HOST = "linux-1-000";
const MIN = 60_000;

async function ready(scenario: FakeScenario = fixtures.edit as FakeScenario, pullFreshMinutes = 5) {
  const user = userEvent.setup();
  const backend = fakeBackend(scenario);
  let pulls = 0;
  const counted: Backend = new Proxy(backend, {
    get(target, prop: keyof Backend) {
      const v = target[prop];
      if (prop !== "pullInventory" || typeof v !== "function") return v;
      return () => {
        pulls++;
        return target.pullInventory();
      };
    },
  });
  const clock = manualClock();
  render(
    <App
      backend={counted}
      clock={clock}
      terminalView={StubTerminal}
      platform={memoryPlatform()}
      options={{ ...defaultOptions, pullFreshMinutes }}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  // The confirmations' whole text shows with every message on (ticket 111).
  await user.keyboard(`${LEADER}:messages all{Enter}`);
  return { user, backend, clock, pulls: () => pulls };
}

const editForm = () => screen.findByRole("region", { name: `Edit ${HOST}` });
const closeForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("region", { name: /^Edit |Add a Host/ })).toBeNull());
};

describe("the pull before an Inventory write (Q88)", () => {
  it("opens the form at once and pulls in the background, then not again while that pull is fresh", async () => {
    const { user, pulls } = await ready({
      ...(fixtures.edit as FakeScenario),
      pullDelay: 200,
    });
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await editForm();
    // The form is usable while the pull runs.
    expect(within(panel).getByLabelText("Title")).toHaveFocus();
    expect(within(panel).getByText("Pulling the infra repo in the background…")).toBeInTheDocument();
    expect(await within(panel).findByText("Up to date with origin/main.")).toBeInTheDocument();
    expect(pulls()).toBe(1);
    await closeForm(user);

    await user.keyboard(`${LEADER}:host add{Enter}`);
    const add = await screen.findByRole("region", { name: "Add a Host" });
    expect(within(add).getByText(/Pulled the infra repo under a minute ago, so roster didn't pull again/)).toBeInTheDocument();
    expect(pulls()).toBe(1);
  });

  it("pulls again once the last pull is older than pull_fresh_minutes", async () => {
    const { user, clock, pulls } = await ready();
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    await within(await editForm()).findByText("Up to date with origin/main.");
    await closeForm(user);
    act(() => clock.advance(4 * MIN));
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    expect(await within(await editForm()).findByText(/4 minutes ago, so roster didn't pull again/)).toBeInTheDocument();
    expect(pulls()).toBe(1);
    await closeForm(user);
    act(() => clock.advance(2 * MIN));
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    expect(await within(await editForm()).findByText("Up to date with origin/main.")).toBeInTheDocument();
    expect(pulls()).toBe(2);
  });

  it("pulls every time with pull_fresh_minutes = 0", async () => {
    const { user, pulls } = await ready(fixtures.edit as FakeScenario, 0);
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    await within(await editForm()).findByText("Up to date with origin/main.");
    await closeForm(user);
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    await within(await editForm()).findByText("Up to date with origin/main.");
    expect(pulls()).toBe(2);
  });

  it("saves only once the background pull is done", async () => {
    const { user, backend, pulls } = await ready({
      ...(fixtures.edit as FakeScenario),
      pullDelay: 300,
    });
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await editForm();
    const title = within(panel).getByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Build box{Enter}");
    expect(await screen.findByText(/Saved linux-1-000 as a Pending change/)).toBeInTheDocument();
    expect((await backend.getHost(HOST)).title).toBe("Build box");
    expect(pulls()).toBe(1);
  });

  it("keeps the form open when the pull diverged, and blocks the save with the same error", async () => {
    const { user, backend } = await ready(fixtures["edit-diverged"] as FakeScenario);
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await editForm();
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't pull the infra repo, so nothing can be saved yet.");
    expect(alert).toHaveTextContent(/diverged/);
    expect(alert).toHaveTextContent(/pull --rebase/);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    const title = within(panel).getByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Build box{Enter}");
    await waitFor(() => expect(within(panel).getByRole("alert")).toHaveTextContent(/diverged/));
    expect((await backend.getHost(HOST)).title).not.toBe("Build box");
    expect((await backend.pendingChanges()).count).toBe(0);
    expect(within(panel).getByLabelText(/^Title/)).toHaveValue("Build box");
  });

  it("says so when the pull changed the Host, and keeps what you typed", async () => {
    const scenario: FakeScenario = {
      ...(fixtures.edit as FakeScenario),
      pullDelay: 200,
      pullBrings: {
        commits: 2,
        changes: { [HOST]: { ip: "10.0.0.9", title: "Theirs" } },
      },
    };
    const { user } = await ready(scenario);
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    const panel = await editForm();
    const title = within(panel).getByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Mine");
    const note = await within(panel).findByRole("status");
    await waitFor(() =>
      expect(note).toHaveTextContent(
        /The pull changed linux-1-000: Address now shows the new value; Title changed there too, and yours is kept/,
      ),
    );
    expect(within(panel).getByLabelText(/^Title/)).toHaveValue("Mine");
    expect(within(panel).getByLabelText("Address")).toHaveValue("10.0.0.9");
    expect(within(panel).getByText(/Pulled 2 new commits from origin\/main/)).toBeInTheDocument();
  });

  it("in :host add, calls out a name the pull brought (T72)", async () => {
    const theirs = { ...makeHosts(1).hosts[0]!, name: "nas-01" };
    const { user } = await ready({
      ...(fixtures.edit as FakeScenario),
      pullDelay: 200,
      pullBrings: { commits: 1, changes: {}, adds: [theirs] },
    });
    await user.keyboard(`${LEADER}:host add{Enter}`);
    const panel = await screen.findByRole("region", { name: "Add a Host" });
    await user.type(within(panel).getByLabelText(/^Name/), "nas-01");
    expect(within(panel).queryByText(/The pull brought a Host named/)).toBeNull();
    const note = await within(panel).findByText(/The pull brought a Host named/);
    expect(note).toHaveTextContent("The pull brought a Host named nas-01, so this one needs another name.");
  });

  it("doesn't pull when Pending changes are already here", async () => {
    const { user, pulls } = await ready(fixtures["edit-pending"] as FakeScenario);
    await user.keyboard(`${LEADER}:edit ${HOST}{Enter}`);
    expect(within(await editForm()).getByText(/didn't pull/)).toBeInTheDocument();
    expect(pulls()).toBe(0);
  });
});
