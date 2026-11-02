// Hiding every keycap hint (iteration 3 feedback): `:hints off` (kept in the State) or init.lua's
// `ui.hints = false`. The hints go out of sight; the keys keep working and stay in what assistive
// tech reads.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { configWith } from "./config/fixture";
import type { Config, ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const LEADER = "{Control>} {/Control}";

const report = (config: Config): ConfigReport => ({ config, error: null, path: "/home/me/.config/roster/init.lua", version: 1 });

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

const hintsAttr = () => document.documentElement.dataset.hints;
const statusbar = () => document.querySelector(".statusbar") as HTMLElement;
const message = () => document.querySelector(".message-line") as HTMLElement;

describe("Hiding the key hints", () => {
  it("are shown by default", async () => {
    await ready();
    expect(hintsAttr()).toBe("on");
  });

  it(":hints off hides them (kept in the State), and the keys still work", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}:hints off{Enter}`);
    expect(hintsAttr()).toBe("off");
    // Quiet by default (ticket 111): only a screen reader hears it.
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toContain("Key hints hidden");
    await new Promise((r) => setTimeout(r, 0));
    expect(platform.saved()).toMatchObject({ hints: false });
    // Every hint is marked so the stylesheet can hide it: the status bar's, the empty state's.
    for (const hint of statusbar().querySelectorAll(".hint")) expect(hint).toHaveClass("key-hint");
    expect(document.querySelector(".empty-hint")).toHaveClass("key-hint");
    // The names stay: the Find button still says its keys to assistive tech.
    expect(screen.getByRole("button", { name: /^Find a Host, Leader f$/ })).toBeInTheDocument();
    await user.keyboard(`${LEADER}f`);
    const picker = await screen.findByRole("dialog", { name: /find a host/i });
    for (const hint of picker.querySelectorAll(".picker-hint")) expect(hint).toHaveClass("key-hint");
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:hints{Enter}`);
    expect(hintsAttr()).toBe("on");
  });

  it("starts hidden when the State says so", async () => {
    await ready({ state: { version: 1, recentHosts: [], folded: [], hints: false } });
    expect(hintsAttr()).toBe("off");
  });

  it("init.lua's ui.hints wins over the State, and :hints says to change it there", async () => {
    const { user } = await ready({ config: configWith({ ui: { hints: false, messages: null } }), state: { version: 1, hints: true } });
    expect(hintsAttr()).toBe("off");
    await user.keyboard(`${LEADER}:hints on{Enter}`);
    expect(hintsAttr()).toBe("off");
    expect(message()).toHaveTextContent("Key hints are set in init.lua (ui.hints = false). Change them there.");
  });

  it(":hints completes on, off and toggle", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:hints `);
    const list = await screen.findByRole("listbox", { name: "Completions" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^hints on/),
      expect.stringMatching(/^hints off/),
      expect.stringMatching(/^hints toggle/),
    ]);
  });
});
