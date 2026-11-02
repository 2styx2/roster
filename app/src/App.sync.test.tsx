// T150 (#269) through the App with the fake Backend: roster syncs this Box (its ssh config) after
// every Inventory change it writes, so nothing says to run roster sync after a change any more.
// A sync that failed doesn't undo the change: the confirmation says so as a warning, which always
// shows, with what to run.
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_HOST_PASSWORD, FAKE_PASSWORD, fakeBackend, fixtures, type FakeBackend, type FakeScenario } from "./backend/fake";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const SYNC_ERROR = "Permission denied: /home/you/.ssh/config.d/roster";
const FOLLOW = /But this Box's ssh config didn't follow \(Permission denied: \/home\/you\/\.ssh\/config\.d\/roster\): run roster sync\./;

async function ready(scenario: FakeScenario, config: Config = defaultConfig) {
  const user = userEvent.setup();
  const backend: FakeBackend = fakeBackend(scenario);
  const report: ConfigReport = { config, error: null, path: "/home/me/.config/roster/init.lua", version: 1 };
  const platform = memoryPlatform({ config: report });
  render(<App backend={backend} terminalView={StubTerminal} registries={builtinRegistries()} platform={platform} config={report} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend };
}

async function addNas(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard(`${LEADER}:host add{Enter}`);
  const panel = await screen.findByRole("region", { name: "Add a Host" });
  for (const [label, value] of Object.entries({ Name: "nas-01", Address: "10.19.1.50", User: "root" })) {
    await user.clear(within(panel).getByLabelText(label));
    await user.type(within(panel).getByLabelText(label), value);
  }
  await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
  await user.keyboard("{Enter}");
  await user.click(await within(panel).findByRole("button", { name: "Trust it and add" }));
}

const add = fixtures.add as FakeScenario;
const live = { ...add, apiVersion: 8 };

describe("this Box's ssh config after a change", () => {
  it("an added Host can be opened straight away: nothing says to run roster sync", async () => {
    const { user } = await ready(add);
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await addNas(user);
    expect(await screen.findByText(/Added nas-01 to subnet-1 as a Pending change; its password is in the vault as nas-01 ssh\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/roster sync/)).toBeNull();
  });

  it("a sync that failed after an add is a warning, and the Host stays added", async () => {
    const { user } = await ready({ ...add, syncError: SYNC_ERROR });
    await addNas(user);
    expect(await screen.findByText(FOLLOW)).toBeInTheDocument();
    expect(await screen.findByRole("treeitem", { name: /^nas-01, / })).toBeInTheDocument();
  });

  it("a rename no longer says Sessions wait for roster sync", async () => {
    const { user } = await ready(live);
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await user.keyboard(`${LEADER}:host rename linux-1-000 web-1{Enter}`);
    expect(await screen.findByText(/^Renamed linux-1-000 to web-1 as a Pending change\.$/)).toBeInTheDocument();
  });

  it("a sync that failed after a Live Inventory change is a warning", async () => {
    const { user } = await ready({ ...live, syncError: SYNC_ERROR });
    await user.keyboard(`${LEADER}:host rename linux-1-000 web-1{Enter}`);
    expect(await screen.findByText(FOLLOW)).toBeInTheDocument();
  });

  // T153: the pull a form runs before saving syncs too, when it brought commits.
  const pulling = { ...(fixtures.edit as FakeScenario), syncError: SYNC_ERROR, pullBrings: { commits: 2, changes: {} } };
  const pullFollow = (commits: string) =>
    new RegExp(`^Pulled 2 ${commits} from origin/main, but this Box's ssh config didn't follow \\(${SYNC_ERROR}\\): run roster sync\\.$`);

  it("a sync that failed after a form's pull says so in the form", async () => {
    const { user } = await ready(pulling);
    await user.keyboard(`${LEADER}:edit linux-1-000{Enter}`);
    const panel = await screen.findByRole("region", { name: "Edit linux-1-000" });
    expect(await within(panel).findByText(pullFollow("new commits"))).toBeInTheDocument();
  });

  it("a sync that failed after :pull says so", async () => {
    const { user } = await ready(pulling);
    await user.keyboard(`${LEADER}:pull{Enter}`);
    expect(await screen.findByText(pullFollow("commits"))).toBeInTheDocument();
  });

  it("a sync that failed after an outside edit was applied is a warning", async () => {
    const { backend } = await ready({ ...live, syncError: SYNC_ERROR }, configWith({ autoReload: true }));
    await waitFor(() => expect(backend.watching()).toBe(true));
    const hosts = add.hosts;
    if (!hosts) throw new Error("fixture has Hosts");
    act(() => backend.outsideEdit({ ...hosts, hosts: hosts.hosts.map((h) => (h.name === "linux-1-000" ? { ...h, name: "linux-renamed" } : h)) }));
    expect(await screen.findByText(/roster\.yml changed outside the app and was applied, but this Box's ssh config didn't follow/)).toBeInTheDocument();
  });
});
