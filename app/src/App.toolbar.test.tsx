// The toolbar (issue #78, item 3; decision Q65): visible controls for the common commands, in the
// title bar by default, each a registry entry that init.lua's layout table (decision Q39) can drop
// or reorder. Fake Backend, stub terminal.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

let reloads = 0;
const report = (config: Config): ConfigReport => ({ config, error: null, path: "/home/me/.config/roster/init.lua", version: ++reloads });

async function ready(scenario: FakeScenario = fixtures.review as FakeScenario, config: Config = defaultConfig) {
  const user = userEvent.setup();
  const platform = memoryPlatform({ config: report(config) });
  render(
    <App
      backend={fakeBackend(scenario)}
      terminalView={StubTerminal}
      registries={builtinRegistries()}
      platform={platform}
      config={report(config)}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const toolbar = () => screen.getByRole("toolbar", { name: "Commands" });
const names = () => within(toolbar()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);

/** The modes with Standard's toolbar set as init.lua would. */
function withToolbar(toolbar: Config["modes"]["standard"]["toolbar"]): Config {
  const modes = structuredClone(defaultConfig.modes);
  modes.standard.toolbar = toolbar;
  return configWith({ modes });
}

describe("the toolbar", () => {
  it("shows Add Host, Host details and Lock by default (Find while the Sidebar is hidden, Changes while there are some); Add Host opens the form", async () => {
    const user = await ready();
    expect(within(screen.getByRole("banner")).getByRole("toolbar", { name: "Commands" })).toBeInTheDocument();
    expect(names()).toEqual(["Add a Host", "Show Host details", "Lock"]);
    // The Sidebar has its own Find field; hidden, the title bar offers Find.
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "Hide the Sidebar" }));
    expect(names()).toEqual(["Find a Host", "Add a Host", "Show Host details", "Lock"]);
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "Show the Sidebar" }));
    await user.click(within(toolbar()).getByRole("button", { name: "Add a Host" }));
    expect(await screen.findByRole("region", { name: "Add a Host" })).toBeInTheDocument();
  });

  it("shows Publish, and the count on Changes, while there are Pending changes", async () => {
    const user = await ready({ ...(fixtures["edit-pending"] as FakeScenario) });
    const changes = await within(toolbar()).findByRole("button", { name: "Pending changes: 2" });
    expect(changes).toHaveTextContent("2");
    await user.click(within(toolbar()).getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("region", { name: "Pending changes" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Publish the Pending changes")).toBeInTheDocument();
  });

  it("follows init.lua's layout table: modes.standard.toolbar picks and orders the controls", async () => {
    await ready(fixtures.review as FakeScenario, withToolbar({ shown: true, controls: ["changes", "add", "lock"] }));
    // No Pending changes in this fixture, so Changes isn't drawn.
    expect(names()).toEqual(["Add a Host", "Lock"]);
  });

  it("has a help control (ticket 37), off by default like keys, that init.lua can add", async () => {
    const user = await ready(fixtures.review as FakeScenario, withToolbar({ shown: true, controls: ["help", "keys"] }));
    expect(names()).toEqual(["Help", "Key bindings"]);
    await user.click(within(toolbar()).getByRole("button", { name: "Help" }));
    expect(await screen.findByRole("dialog", { name: /find a help topic/i })).toBeInTheDocument();
  });

  it("is gone with toolbar = false, and in Focus by default", async () => {
    await ready(fixtures.review as FakeScenario, withToolbar({ shown: false, controls: null }));
    expect(screen.queryByRole("toolbar", { name: "Commands" })).toBeNull();
  });

  it("warns about a control it doesn't know, and shows the rest", async () => {
    await ready(fixtures.review as FakeScenario, withToolbar({ shown: true, controls: ["add", "frobnicate"] }));
    expect(await screen.findByText(/modes\.standard\.toolbar: no control named "frobnicate"/)).toBeInTheDocument();
    expect(names()).toEqual(["Add a Host"]);
  });
});
