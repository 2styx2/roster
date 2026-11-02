// Tab completion everywhere (ticket 34): the command line completes commands and their arguments
// from the command table's `complete` hooks and the registries, bash-style (the longest common
// prefix first, then Tab / Shift+Tab cycle through a listbox), and the Picker and every finder
// take Tab / Shift+Tab to move through their results, Tab first filling the query with what the
// matches share. Through the App with the fake Backend and a stub terminal. user-event writes
// Ctrl+Space as {Control>} {/Control}.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import type { CommandDef } from "./commands/table";
import { defaultOptions, registerBindings, type KeymapOverrides, type Options } from "./keymap";
import { builtinRegistries, type Registries } from "./registries";
import { CONFIG } from "./registry";
import { StubTerminal } from "./terminal/StubTerminal";

// linux-1-000 esxi-2-001 proxmox-3-002 switch-4-003 (unreviewed) router-1-004 windows-2-005
// printer-3-006 nas-4-007 linux-1-008 esxi-2-009 proxmox-3-010 (unreviewed) switch-4-011
const hosts = makeHosts(12);
const LEADER = "{Control>} {/Control}";

type User = ReturnType<typeof userEvent.setup>;

async function ready(
  props: { options?: Partial<Options>; bindings?: KeymapOverrides; setup?: (r: Registries) => void } = {},
): Promise<User> {
  const user = userEvent.setup();
  const registries = builtinRegistries();
  if (props.bindings) registerBindings(registries.keymap, props.bindings, CONFIG);
  props.setup?.(registries);
  render(
    <App
      backend={fakeBackend({ hosts })}
      terminalView={StubTerminal}
      options={{ ...defaultOptions, ...props.options }}
      registries={registries}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const cmdline = () => screen.getByRole("combobox", { name: "Command" });
const completions = () => screen.getByRole("listbox", { name: "Completions" });
const candidates = () => within(completions()).getAllByRole("option").map((o) => o.querySelector(".cmd-id")?.textContent);
const selected = () => within(completions()).queryByRole("option", { selected: true });
const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });

describe("The command line completes like a shell", () => {
  it("fills the longest common prefix first, then Tab and Shift+Tab cycle through the list", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:connect es{Tab}`);
    expect(cmdline()).toHaveValue("connect esxi-2-00");
    expect(candidates()).toEqual(["connect esxi-2-001", "connect esxi-2-009"]);
    expect(selected()).toBeNull();

    await user.keyboard("{Tab}");
    expect(cmdline()).toHaveValue("connect esxi-2-001");
    expect(selected()).toHaveTextContent("connect esxi-2-001");
    expect(cmdline()).toHaveAttribute("aria-activedescendant", selected()!.id);
    await user.keyboard("{Tab}");
    expect(cmdline()).toHaveValue("connect esxi-2-009");
    await user.keyboard("{Tab}");
    expect(cmdline()).toHaveValue("connect esxi-2-001");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(cmdline()).toHaveValue("connect esxi-2-009");
  });

  it("Esc cancels the completion, back to what was typed; a second Esc closes the line", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:connect esxi-2-00{Tab}`);
    expect(cmdline()).toHaveValue("connect esxi-2-001");
    await user.keyboard("{Escape}");
    expect(cmdline()).toHaveValue("connect esxi-2-00");
    expect(selected()).toBeNull();
    expect(cmdline()).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox", { name: "Command" })).toBeNull();
  });

  it("Ctrl+Y accepts a completion and lists the next argument's", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:con{Tab}`);
    expect(cmdline()).toHaveValue("connect ");
    await user.keyboard("{Control>}y{/Control}");
    expect(cmdline()).toHaveValue("connect ");
    expect(selected()).toBeNull();
    expect(candidates()).toContain("connect linux-1-000");
    await user.keyboard("na{Tab}");
    expect(cmdline()).toHaveValue("connect nas-4-007");
    await user.keyboard("{Enter}");
    expect(await within(output()).findByText(/Connected to nas-4-007/)).toBeInTheDocument();
  });

  it("Enter accepts a command that still needs its argument instead of running it", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:con{Tab}`);
    expect(cmdline()).toHaveValue("connect ");
    await user.keyboard("{Enter}");
    expect(cmdline()).toHaveValue("connect ");
    expect(screen.queryByText(/connect needs a Host name/)).toBeNull();
    expect(candidates()).toContain("connect esxi-2-001");
  });

  it("Enter on a whole completion runs it", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:connect nas{Tab}{Enter}`);
    expect(await within(output()).findByText(/Connected to nas-4-007/)).toBeInTheDocument();
  });

  it("completes every command and its arguments: themes, finder sources, modes, :config, fold ids", async () => {
    const user = await ready();
    const typed = async (line: string) => {
      await user.keyboard(`${LEADER}:${line}`);
      const out = candidates();
      await user.keyboard("{Escape}{Escape}");
      return out;
    };
    expect(await typed("theme ")).toEqual(expect.arrayContaining(["theme roster-dark", "theme nord"]));
    expect(await typed("finder ")).toEqual(expect.arrayContaining(["finder sessions", "finder hosts", "finder tree"]));
    expect(await typed("mode ")).toEqual(["mode standard", "mode focus"]);
    expect(await typed("pu")).toEqual(["publish", "pull"]);
    expect(await typed("config ")).toEqual(["config reload", "config path", "config import-terminal", "config types"]);
    expect(await typed("fold group:")).toEqual(
      expect.arrayContaining(["fold group:subnet-1", "fold group:subnet-2", "fold group:subnet-3", "fold group:subnet-4"]),
    );
    expect(await typed("fold sec")).toEqual(expect.arrayContaining(["fold section:sessions", "fold section:inventory"]));
  });

  it("completes a Folder's name after :folder add HOST", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:folder new Lab ESXi{Enter}`);
    await user.keyboard(`${LEADER}:folder add esxi-2-001 {Tab}`);
    expect(cmdline()).toHaveValue("folder add esxi-2-001 Lab ESXi");
  });

  it("a Plugin's command and a Config's Theme complete the same way", async () => {
    const greet: CommandDef = {
      id: "greet",
      source: "hello-plugin",
      area: "App",
      arg: "text",
      label: () => "Say hello",
      run: (ctx, who) => ctx.say(`hello ${who}`),
      complete: (arg) => ["world", "wide web"].filter((w) => w.startsWith(arg)),
    };
    const user = await ready({
      setup: (r) => {
        r.commands.register(greet);
        const nord = r.themes.get("nord")!;
        r.themes.register({ ...nord, id: "my-night", label: "My night", source: CONFIG });
      },
    });
    await user.keyboard(`${LEADER}:gr{Tab}`);
    expect(cmdline()).toHaveValue("greet ");
    await user.keyboard("w{Tab}");
    expect(candidates()).toEqual(["greet world", "greet wide web"]);
    expect(cmdline()).toHaveValue("greet world");
    await user.keyboard("{Tab}{Enter}");
    expect(await screen.findByText("hello wide web")).toBeInTheDocument();

    await user.keyboard(`${LEADER}:theme my{Tab}`);
    expect(cmdline()).toHaveValue("theme my-night");
  });

  it("init.lua can rebind its keys (keys.cmdline)", async () => {
    const user = await ready({ bindings: { cmdline: { "Ctrl+j": "cmdline.next", Tab: null } } });
    await user.keyboard(`${LEADER}:connect esxi-2-00{Control>}j{/Control}`);
    expect(cmdline()).toHaveValue("connect esxi-2-001");
  });

  it("works the same in Focus", async () => {
    const user = await ready({ options: { defaultMode: "focus" } });
    expect(document.querySelector(".screen.app")).toHaveAttribute("data-view", "focus");
    await user.keyboard(`${LEADER}:connect es{Tab}{Tab}{Tab}`);
    expect(cmdline()).toHaveValue("connect esxi-2-009");
    await user.keyboard("{Shift>}{Tab}{/Shift}{Escape}");
    expect(cmdline()).toHaveValue("connect esxi-2-00");
  });
});

describe("Tab in the Picker and the finders", () => {
  const picker = () => screen.getByRole("dialog", { name: "Find a Host" });
  const query = () => within(picker()).getByRole("combobox");
  const pickerSelected = () => within(picker()).getByRole("option", { selected: true }).getAttribute("data-host");

  it("Tab fills the matches' common prefix, then Tab and Shift+Tab move through the results", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("es{Tab}");
    expect(query()).toHaveValue("esxi-2-00");
    expect(pickerSelected()).toBe("esxi-2-001");
    await user.keyboard("{Tab}");
    expect(query()).toHaveValue("esxi-2-00");
    expect(pickerSelected()).toBe("esxi-2-009");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(pickerSelected()).toBe("esxi-2-001");
    await user.keyboard("{Tab}{Enter}");
    expect(await within(output()).findByText(/Connected to esxi-2-009/)).toBeInTheDocument();
  });

  it("with nothing typed, Tab and Shift+Tab move (and wrap) alongside the arrows", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}f`);
    const first = pickerSelected();
    await user.keyboard("{Tab}");
    expect(pickerSelected()).not.toBe(first);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(pickerSelected()).toBe(first);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    const rows = within(picker()).getAllByRole("option");
    expect(pickerSelected()).toBe(rows.at(-1)!.getAttribute("data-host"));
    await user.keyboard("{Escape}");
  });

  it("every finder source takes Tab the same way (`finder hosts`, in Focus)", async () => {
    const user = await ready({ options: { defaultMode: "focus" } });
    await user.keyboard(`${LEADER}:finder hosts{Enter}`);
    const finder = screen.getByRole("dialog", { name: /^Find/ });
    const finderSelected = () => within(finder).getByRole("option", { selected: true }).getAttribute("data-label");
    await user.keyboard("es{Tab}");
    expect(within(finder).getByRole("combobox")).toHaveValue("esxi-2-00");
    expect(finderSelected()).toBe("esxi-2-001");
    await user.keyboard("{Tab}");
    expect(finderSelected()).toBe("esxi-2-009");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(finderSelected()).toBe("esxi-2-001");
  });
});

describe("The Key bindings panel", () => {
  it("lists Tab and Shift+Tab for the command line and the Picker, with their source and option", async () => {
    const user = await ready({ bindings: { picker: { "Ctrl+j": "picker.next" } } });
    await user.keyboard(`${LEADER}K`);
    const panel = screen.getByRole("complementary", { name: "Key bindings" });
    const rows = within(panel).getAllByRole("row");
    // A built-in binding's source cell is empty; the Config's says init.lua.
    const rowOf = (label: RegExp, source = "") =>
      rows.find((r) => label.test(r.textContent ?? "") && r.querySelector(".keys-source")?.textContent === source);
    const keysOf = (label: RegExp, source = "") => rowOf(label, source)?.querySelector(".keys-keys")?.textContent;
    const optionOf = (label: RegExp) => rowOf(label)?.querySelector(".keys-option")?.textContent;
    expect(keysOf(/Next completion/)).toMatch(/^Tab/);
    expect(optionOf(/Next completion/)).toBe("keys.cmdline");
    expect(keysOf(/Previous completion/)).toMatch(/^Shift\+Tab/);
    expect(keysOf(/Accept the completion/)).toBe("Ctrl+y");
    expect(keysOf(/Next result/)).toMatch(/Tab/);
    expect(optionOf(/Next result/)).toBe("keys.picker");
    expect(keysOf(/Previous result/)).toMatch(/Shift\+Tab/);
    expect(keysOf(/Next result/, "init.lua")).toBe("Ctrl+j");
  });
});
