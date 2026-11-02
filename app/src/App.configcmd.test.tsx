// `:config` and configuration made discoverable (ticket 32, taste "Made to be made yours"):
// `:config` makes init.lua from the commented-out example once and opens it, never overwriting
// a file that's there; `:config reload` and `:config path`; and the option's name wherever a
// configurable thing shows (the Key bindings panel, the theme finder, the layout pieces). The
// memory Platform stands in for the core's config dir (roster-core config/editor.rs has the
// file's own tests). Fake Backend, stub terminal; user-event writes Ctrl+Space as {Control>} {/Control}.
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
const PATH = "/home/me/.config/roster/init.lua";
type User = ReturnType<typeof userEvent.setup>;

let reloads = 0;
const report = (config: Config): ConfigReport => ({ config, error: null, path: PATH, version: ++reloads });

async function ready(opts: { file?: string | null; config?: Config } = {}) {
  const user = userEvent.setup();
  const r = report(opts.config ?? defaultConfig);
  const platform = memoryPlatform({ config: r, configFile: opts.file ?? null });
  render(
    <App
      backend={fakeBackend({ hosts })}
      terminalView={StubTerminal}
      registries={builtinRegistries()}
      platform={platform}
      config={r}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, platform };
}

async function command(user: User, line: string) {
  await user.keyboard(`${LEADER}:`);
  await user.keyboard(`${line}{Enter}`);
}

const messageLine = () => document.querySelector(".message-line") as HTMLElement;

describe(":config", () => {
  it("creates init.lua from the commented-out example the first time, then only opens it", async () => {
    const { user, platform } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    expect(platform.configFile()).toBeNull();
    await command(user, "config");
    await screen.findByText(new RegExp(`Created ${PATH}`));
    expect(messageLine()).toHaveTextContent("every option commented out");
    const made = platform.configFile();
    expect(made).toMatch(/^-- /);
    expect(platform.opened()).toEqual([PATH]);

    await command(user, "config");
    await screen.findByText(`Opened ${PATH}. Saving it applies it.`);
    expect(platform.configFile()).toBe(made);
    expect(platform.opened()).toEqual([PATH, PATH]);
  });

  it("never overwrites a file that's there", async () => {
    const { user, platform } = await ready({ file: "return { vim = false }\n" });
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await command(user, "config");
    await screen.findByText(`Opened ${PATH}. Saving it applies it.`);
    expect(platform.configFile()).toBe("return { vim = false }\n");
  });

  it("says why when the file can't be opened", async () => {
    const { user, platform } = await ready();
    platform.failOpen("editor = \"wsl\" works on Windows only; use \"os\" here");
    await command(user, "config");
    await screen.findByText(/Can't open init\.lua: editor = "wsl" works on Windows only/);
  });

  it("path says where the file is", async () => {
    const { user } = await ready();
    await command(user, "config path");
    expect(messageLine()).toHaveTextContent(`init.lua is at ${PATH}`);
  });

  it("reload reads the file again and applies it", async () => {
    const { user, platform } = await ready();
    // What's on disk now, with no save event (the watcher missed it, or a synced file).
    platform.writeConfig(report(configWith({ leader: "Ctrl+B" })));
    await command(user, "config reload");
    await screen.findByText("Reloaded init.lua");
    await user.keyboard("{Control>}b{/Control}K");
    expect(screen.getByRole("complementary", { name: "Key bindings" })).toBeInTheDocument();
  });

  it("completes its subcommands and refuses others", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:`);
    await user.keyboard("config r{Tab}");
    expect(screen.getByRole("combobox")).toHaveValue("config reload");
    await user.keyboard("{Escape}");
    await command(user, "config nope");
    expect(messageLine()).toHaveTextContent("config takes nothing, reload, path, import-terminal or types");
  });

  it("types writes the option types into the config folder, for lua-language-server", async () => {
    const { user, platform } = await ready();
    await command(user, "config types");
    await screen.findByText(/^Wrote \/home\/me\/\.config\/roster\/types\/roster-config\.lua/);
    expect(messageLine()).toHaveTextContent(":help options#editor-support");
    expect(platform.typesWritten()).toBe(1);
  });

  it("says why the types couldn't be written", async () => {
    const { user, platform } = await ready();
    platform.failTypes("/home/me/.config/roster/types is a link: roster won't write through it");
    await command(user, "config types");
    await screen.findByText(/Couldn't write the types: .*is a link/);
  });
});

describe("Option names where configurable things show", () => {
  it("the Key bindings panel names each binding's option, and the Leader's", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}K`);
    const panel = screen.getByRole("complementary", { name: "Key bindings" });
    const rowOf = (label: RegExp) => within(panel).getAllByRole("row").find((r) => label.test(r.textContent ?? ""))!;
    expect(within(rowOf(/^Leader: take the keys back/)).getByText("leader", { selector: "code" })).toBeInTheDocument();
    expect(rowOf(/^Lock/)).toHaveTextContent("keys.leader");
    expect(rowOf(/^Copy/)).toHaveTextContent("keys.terminal");
    expect(within(panel).getByText(/in init\.lua: the name is under each one/)).toBeInTheDocument();
    // The filter finds bindings by option name.
    await user.type(within(panel).getByRole("searchbox"), "keys.terminal");
    expect(within(panel).queryByText(/^Lock$/)).toBeNull();
    expect(within(panel).getByText("Copy")).toBeInTheDocument();
  });

  it("the theme finder names the option for the Theme under the cursor", async () => {
    const { user } = await ready();
    await command(user, "theme");
    const finder = screen.getByRole("dialog", { name: "Choose a Theme" });
    await user.keyboard("{ArrowDown}");
    const id = within(finder).getByRole("option", { selected: true }).getAttribute("data-label");
    expect(id).toBe("Roster light");
    expect(finder).toHaveTextContent(/In init\.lua: theme = "roster-light"/);
  });

  it("showing or hiding a layout piece names its option, with every message on", async () => {
    const { user } = await ready();
    // Quiet by default (ticket 111).
    await command(user, "messages all");
    await user.keyboard(`${LEADER}e`);
    expect(messageLine()).toHaveTextContent("Sidebar hidden, and kept that way. modes.standard.sidebar = false in init.lua makes it the default");
    await user.keyboard(`${LEADER}s`);
    expect(messageLine()).toHaveTextContent("Status bar hidden. To keep it that way: modes.standard.statusbar = false in init.lua");
    await user.keyboard(`${LEADER}e`);
    expect(messageLine()).toHaveTextContent("Sidebar shown, and kept that way. modes.standard.sidebar = true in init.lua makes it the default");
  });
});
