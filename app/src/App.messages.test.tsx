// The message line, as Neovim's (ticket 111, decision Q115): quiet by default, so errors,
// warnings and answers show and a routine confirmation or a tip doesn't; `ui.messages = "all"` in
// init.lua, or `:messages all` (kept in the State unless init.lua sets it, which wins), brings
// them back. Quiet, a screen reader still hears what changed, and `:messages` lists them all.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(6);
const LEADER = "{Control>} {/Control}";
const SIDEBAR_TIP = "Sidebar hidden, and kept that way. modes.standard.sidebar = false in init.lua makes it the default";

const report = (config: Config): ConfigReport => ({ config, error: null, path: "/home/me/.config/roster/init.lua", version: 1 });
const messagesSet = (messages: "quiet" | "all") => configWith({ set: ["ui.messages"], ui: { ...defaultConfig.ui, messages } });

async function ready({ config, state }: { config?: Config; state?: Record<string, unknown> } = {}) {
  const user = userEvent.setup();
  const platform = memoryPlatform({ ...(config ? { config: report(config) } : {}), ...(state ? { state } : {}) });
  render(
    <App
      backend={fakeBackend({ hosts })}
      terminalView={StubTerminal}
      registries={builtinRegistries()}
      platform={platform}
      {...(config ? { config: report(config) } : {})}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, platform };
}

const messageLine = () => document.querySelector(".message-line") as HTMLElement;
/** What a sighted user sees on the message line: nothing while it's visually hidden. */
const seen = () => (messageLine().classList.contains("visually-hidden") ? "" : (messageLine().textContent ?? ""));

describe("the message line", () => {
  it("is quiet by default: a toggle shows nothing, and a screen reader still hears what changed", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}e`);
    expect(seen()).toBe("");
    expect(messageLine()).toHaveAttribute("role", "status");
    expect(messageLine()).toHaveTextContent(/^Sidebar hidden$/);
    await user.keyboard(`${LEADER}s`);
    expect(seen()).toBe("");
    expect(messageLine()).toHaveTextContent(/^Status bar hidden$/);
  });

  it("still shows errors and answers when quiet", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:host nope{Enter}`);
    expect(seen()).toContain("host takes");
    await user.keyboard(`${LEADER}:config path{Enter}`);
    expect(seen()).toMatch(/init\.lua/);
  });

  it("shows every message with ui.messages = \"all\" in init.lua", async () => {
    const { user } = await ready({ config: messagesSet("all") });
    await user.keyboard(`${LEADER}e`);
    expect(seen()).toBe(SIDEBAR_TIP);
  });

  it(":messages toggle shows them all, and the State remembers it", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}:messages toggle{Enter}`);
    expect(seen()).toBe("Messages: all");
    await new Promise((r) => setTimeout(r, 0));
    expect(platform.saved()).toMatchObject({ messages: "all" });
    await user.keyboard(`${LEADER}e`);
    expect(seen()).toBe(SIDEBAR_TIP);
  });

  it("starts with them all when the State says so", async () => {
    const { user } = await ready({ state: { version: 1, recentHosts: [], folded: [], messages: "all" } });
    await user.keyboard(`${LEADER}e`);
    expect(seen()).toBe(SIDEBAR_TIP);
  });

  it("follows init.lua over the State, and :messages says to change it there", async () => {
    const { user } = await ready({ config: messagesSet("quiet"), state: { version: 1, recentHosts: [], folded: [], messages: "all" } });
    await user.keyboard(`${LEADER}e`);
    expect(seen()).toBe("");
    expect(messageLine()).toHaveTextContent(/^Sidebar hidden$/);
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    expect(seen()).toBe('Messages are set in init.lua (ui.messages = "quiet"). Change it there.');
  });

  it(":messages alone lists the recent ones, quiet ones too", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}e`);
    await user.keyboard(`${LEADER}:host nope{Enter}`);
    await user.keyboard(`${LEADER}:messages{Enter}`);
    const view = await screen.findByRole("region", { name: /^Messages/ });
    expect(within(view).getByText(SIDEBAR_TIP)).toBeInTheDocument();
    expect(within(view).getByText(/^host takes/)).toBeInTheDocument();
  });

  it("keeps the :messages view open as new messages come in", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:messages{Enter}`);
    await screen.findByRole("region", { name: /^Messages/ });
    await user.keyboard(`${LEADER}e`);
    const view = screen.getByRole("region", { name: /^Messages/ });
    expect(await within(view).findByText(SIDEBAR_TIP)).toBeInTheDocument();
  });
});
