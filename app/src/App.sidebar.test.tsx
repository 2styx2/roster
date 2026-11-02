// Hiding the Sidebar (issue #78, item 2): a visible toggle in the title bar and `sidebar` (␣ e,
// rebindable), in Standard and Focus; what you chose is kept in the State unless init.lua sets
// `modes.<mode>.sidebar`, which wins. Fake Backend, stub terminal.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigReport } from "./config/types";
import { memoryPlatform, type MemoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const LEADER = "{Control>} {/Control}";

let reloads = 0;
const report = (config: Config): ConfigReport => ({ config, error: null, path: "/home/me/.config/roster/init.lua", version: ++reloads });

async function ready(platform: MemoryPlatform = memoryPlatform(), config: Config = defaultConfig) {
  const user = userEvent.setup();
  const r = report(config);
  const view = render(
    <App backend={fakeBackend({ hosts })} terminalView={StubTerminal} registries={builtinRegistries()} platform={platform} config={r} />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, platform, view };
}

const sidebar = () => screen.queryByRole("navigation", { name: "Sidebar" });
const toggle = () => within(screen.getByRole("banner")).getByRole("button", { name: /the Sidebar$/ });

describe("the Sidebar toggle", () => {
  it("is in the title bar, pressed while the Sidebar shows; a click hides it and the State keeps that", async () => {
    const { user, platform, view } = await ready();
    expect(toggle()).toHaveAccessibleName("Hide the Sidebar");
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle());
    expect(sidebar()).toBeNull();
    expect(toggle()).toHaveAccessibleName("Show the Sidebar");
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(platform.saved()).toMatchObject({ sidebar: { standard: false } });
    // The next start keeps it hidden.
    view.unmount();
    await ready(platform);
    expect(sidebar()).toBeNull();
    await user.keyboard(`${LEADER}e`);
    expect(sidebar()).not.toBeNull();
    expect(platform.saved()).toMatchObject({ sidebar: { standard: true } });
  });

  it("init.lua's modes.standard.sidebar wins over the State; the toggle still works until the next start", async () => {
    const platform = memoryPlatform({ state: { sidebar: { standard: false } } });
    const modes = structuredClone(defaultConfig.modes);
    modes.standard.set = ["sidebar"];
    const { user } = await ready(platform, configWith({ modes }));
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    expect(sidebar()).not.toBeNull();
    await user.click(toggle());
    expect(sidebar()).toBeNull();
    expect(await screen.findByText(/init\.lua sets modes\.standard\.sidebar = true/)).toBeInTheDocument();
  });

  it("works in Focus too: ␣ e shows the Sidebar over the terminal, and hides it again", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}m`);
    expect(sidebar()).toBeNull();
    await user.keyboard(`${LEADER}e`);
    expect(sidebar()).not.toBeNull();
    expect(platform.saved()).toMatchObject({ sidebar: { focus: true } });
    await user.keyboard(`${LEADER}e`);
    expect(sidebar()).toBeNull();
  });
});
