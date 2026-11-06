// Focus mode (ticket 22, decision Q36): ␣ m and F11 switch between Standard and Focus, which is
// fullscreen with no chrome; Sessions, Hosts and the Sidebar's tree are reached through finders,
// and every command works in both modes. Through the App with the fake Backend and a stub
// terminal. user-event writes "[" as "[[" and Ctrl+Space as {Control>} {/Control}.
import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import type { CommandDef } from "./commands/table";
import { defaultOptions, keymapOf, type Options } from "./keymap";
import { manualClock } from "./ui/manualClock";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries, type Registries } from "./registries";
import { StubTerminal, STUB_SIZES } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const reviewed = hosts.hosts.filter((h) => h.reviewed).map((h) => h.name);
const [h0, h1, h2] = reviewed as [string, string, string];
const LEADER = "{Control>} {/Control}";

type User = ReturnType<typeof userEvent.setup>;

async function ready(props: { options?: Partial<Options>; registries?: Registries } = {}) {
  const user = userEvent.setup();
  const platform = memoryPlatform();
  const clock = manualClock();
  const options = { ...defaultOptions, ...props.options };
  render(
    <App
      backend={fakeBackend({ hosts })}
      terminalView={StubTerminal}
      options={options}
      registries={props.registries ?? builtinRegistries()}
      platform={platform}
      clock={clock}
    />,
  );
  await unlock(user);
  return { user, platform, clock };
}

async function unlock(user: User) {
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
}

async function connect(user: User, name: string) {
  await user.keyboard(`${LEADER}f`);
  await user.keyboard(name);
  await user.keyboard("{Enter}");
  await within(output()).findByText(new RegExp(`Connected to ${name}`));
}

const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
const onScreen = () => screen.getByRole("group", { name: /^Session / });
const visibleSession = () =>
  screen.getAllByRole("group", { name: /^Session / }).find((g) => !g.hidden)?.getAttribute("aria-label");
const view = () => document.querySelector(".screen.app")?.getAttribute("data-view");
const finder = () => screen.getByRole("dialog", { name: /^Find/ });

describe("Switching view modes", () => {
  it("␣ m goes fullscreen with no Sidebar or status bar, and back, keeping the Session on screen", async () => {
    const { user, platform } = await ready();
    await connect(user, h0);
    await connect(user, h1);
    expect(view()).toBe("standard");
    await user.keyboard(`${LEADER}m`);
    expect(view()).toBe("focus");
    expect(platform.fullscreen()).toBe(true);
    expect(screen.queryByRole("group", { name: "Sessions" })).toBeNull();
    expect(screen.queryByText(/12 hosts/)).toBeNull();
    expect(visibleSession()).toBe(`Session ${h1}`);
    expect(document.activeElement).toHaveAccessibleName("terminal input");
    await user.keyboard(`${LEADER}m`);
    expect(view()).toBe("standard");
    expect(platform.fullscreen()).toBe(false);
    expect(screen.getByRole("group", { name: "Sessions" })).toBeInTheDocument();
    expect(visibleSession()).toBe(`Session ${h1}`);
    expect(onScreen()).toBeInTheDocument();
  });

  it("F11 switches from Terminal mode, without the Leader, and never reaches the shell", async () => {
    const { user, platform } = await ready();
    await connect(user, h0);
    await user.keyboard("{F11}");
    expect(view()).toBe("focus");
    expect(platform.fullscreen()).toBe(true);
    await user.keyboard("{F11}");
    expect(view()).toBe("standard");
    await user.keyboard("ok");
    expect(output()).toHaveTextContent(/ok$/);
  });

  it("starts in the mode the options say (init.lua's default_mode)", async () => {
    const { platform } = await ready({ options: { defaultMode: "focus" } });
    expect(view()).toBe("focus");
    expect(platform.fullscreen()).toBe(true);
  });

  it("shows how to leave for about 2 s on entering Focus", async () => {
    const { user, clock } = await ready();
    await user.keyboard(`${LEADER}m`);
    const hint = screen.getByRole("status", { name: "How to leave Focus" });
    expect(hint).toHaveTextContent(/Leader m/);
    expect(hint).toHaveTextContent(/F11/);
    act(() => clock.advance(2500));
    expect(screen.queryByRole("status", { name: "How to leave Focus" })).toBeNull();
  });

  it("tells the Session its new size on entering and leaving (stty size)", async () => {
    const { user } = await ready();
    await connect(user, h0);
    await user.keyboard(`${LEADER}m`);
    const { cols, rows } = STUB_SIZES.focus;
    expect(await within(output()).findByText(new RegExp(`resized to ${cols}x${rows}`))).toBeInTheDocument();
    await user.keyboard(`${LEADER}m`);
    const back = STUB_SIZES.standard;
    expect(await within(output()).findByText(new RegExp(`resized to ${back.cols}x${back.rows}`))).toBeInTheDocument();
  });
});

describe("Finders in Focus", () => {
  it("␣ b fuzzy-finds open Sessions: Enter switches, Esc closes", async () => {
    const { user } = await ready();
    for (const h of [h0, h1, h2]) await connect(user, h);
    await user.keyboard(`${LEADER}m`);
    await user.keyboard(`${LEADER}b`);
    const options = within(finder()).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("data-label"))).toEqual([h0, h1, h2]);
    // The previous Session starts selected (Telescope's buffer list).
    expect(within(finder()).getByRole("option", { selected: true })).toHaveAttribute("data-label", h1);
    await user.keyboard(h0);
    expect(within(finder()).getAllByRole("option")[0]).toHaveAttribute("data-label", h0);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(visibleSession()).toBe(`Session ${h0}`);
    expect(document.activeElement).toHaveAccessibleName("terminal input");
    await user.keyboard(`${LEADER}b`);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(visibleSession()).toBe(`Session ${h0}`);
    expect(document.activeElement).toHaveAccessibleName("terminal input");
    expect(view()).toBe("focus");
  });

  it("␣ f opens the Picker over the terminal, and a Host opens without leaving Focus", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}m`);
    await connect(user, h2);
    expect(view()).toBe("focus");
    expect(visibleSession()).toBe(`Session ${h2}`);
  });

  it("␣ t opens the Sidebar's tree as a finder: Folders and the Inventory, with paths", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}m`);
    await user.keyboard(`${LEADER}t`);
    expect(finder()).toHaveAccessibleName("Find in the tree");
    await user.keyboard(h1);
    const first = within(finder()).getAllByRole("option")[0]!;
    expect(first).toHaveAttribute("data-label", h1);
    expect(first).toHaveTextContent(/Inventory › subnet-/);
    await user.keyboard("{Enter}");
    expect(await within(output()).findByText(new RegExp(`Connected to ${h1}`))).toBeInTheDocument();
    expect(view()).toBe("focus");
  });

  it("Ctrl+N/P and arrows move in a finder; a click chooses", async () => {
    const { user } = await ready();
    for (const h of [h0, h1]) await connect(user, h);
    await user.keyboard(`${LEADER}m${LEADER}b`);
    await user.keyboard("{ArrowDown}");
    expect(within(finder()).getByRole("option", { selected: true })).toHaveAttribute("data-label", h1);
    await user.keyboard("{Control>}p{/Control}");
    expect(within(finder()).getByRole("option", { selected: true })).toHaveAttribute("data-label", h0);
    await user.click(within(finder()).getAllByRole("option")[1]!);
    expect(visibleSession()).toBe(`Session ${h1}`);
  });

  it("says why an unreviewed Host can't be opened, and stays open", async () => {
    const { user } = await ready();
    const unreviewed = hosts.hosts.find((h) => !h.reviewed)!.name;
    await user.keyboard(`${LEADER}m${LEADER}t`);
    await user.keyboard(`${unreviewed}{Enter}`);
    // The notice, beside the hidden count that a screen reader hears.
    expect(within(finder()).getAllByRole("status").map((s) => s.textContent).join(" ")).toMatch(/isn't reviewed/);
  });
});

describe("The session bar", () => {
  const bar = () => screen.getByRole("navigation", { name: "Session bar" });

  it("is off by default, and ␣ s shows it in Focus", async () => {
    const { user } = await ready();
    await connect(user, h0);
    await user.keyboard(`${LEADER}m`);
    expect(screen.queryByRole("navigation", { name: "Session bar" })).toBeNull();
    await user.keyboard(`${LEADER}s`);
    expect(bar()).toBeInTheDocument();
  });

  it("lists Sessions in order, the current one starred and the previous one marked -", async () => {
    const { user } = await ready({ options: { focus: { sessionbar: "bottom" } } });
    for (const h of [h0, h1, h2]) await connect(user, h);
    await user.keyboard(`${LEADER}m`);
    await user.keyboard(`${LEADER}1`);
    const items = within(bar()).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([`1:${h0}*`, `2:${h1}`, `3:${h2}-`]);
    expect(bar()).toHaveTextContent(`${hosts.hosts[0]!.ip} · password login`);
    await user.click(items[1]!);
    expect(visibleSession()).toBe(`Session ${h1}`);
  });

  it("sits at the top when the option says so", async () => {
    const { user } = await ready({ options: { focus: { sessionbar: "top" } } });
    await connect(user, h0);
    await user.keyboard(`${LEADER}m`);
    expect(bar().closest("[data-place]")).toHaveAttribute("data-place", "top");
  });
});

describe("Every mode keeps all of roster", () => {
  it("panels and overlays work in Focus: key bindings, command line, check, lock", async () => {
    const { user } = await ready();
    await connect(user, h0);
    await user.keyboard(`${LEADER}m`);
    await user.keyboard(`${LEADER}K`);
    expect(screen.getByRole("complementary", { name: "Key bindings" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:`);
    await user.keyboard(`check ${h0}{Enter}`);
    expect(await screen.findByRole("region", { name: `Check ${h0}` })).toBeInTheDocument();
    await user.keyboard(`${LEADER}L`);
    await unlock(user);
    expect(view()).toBe("focus");
    expect(visibleSession()).toBe(`Session ${h0}`);
  });

  /** How a test reaches each command line: a key (after the Leader, or global) and an argument. */
  const ARGS: Record<string, string> = { host: h0, number: "1" };
  function argFor(c: CommandDef): string {
    if (!c.arg) return "";
    if (c.arg !== "text") return ARGS[c.arg] ?? "";
    return c.complete?.("", reviewed)[0]?.trim() ?? "section:inventory";
  }

  /** Wraps every command so the test can count its runs (the real command still runs). */
  function counted() {
    const registries = builtinRegistries();
    const runs = new Map<string, number>();
    const wrap = (c: CommandDef) =>
      registries.commands.register({
        ...c,
        source: "test",
        run: (ctx, arg) => {
          runs.set(c.id, (runs.get(c.id) ?? 0) + 1);
          c.run(ctx, arg);
        },
      });
    /** Wraps what isn't wrapped yet (Folders registers its command once the App mounts). */
    const wrapAll = () => {
      for (const c of registries.commands.list()) if (c.source !== "test") wrap(c);
    };
    wrapAll();
    return { registries, runs, wrapAll };
  }

  /** Back to a known place: no overlay or panel, unlocked, in `mode`, two Sessions open. */
  async function reset(user: User, mode: "standard" | "focus") {
    for (let i = 0; i < 3 && screen.queryByRole("dialog"); i++) {
      if (screen.queryByLabelText(/master password/i)) await unlock(user);
      else await user.keyboard("{Escape}");
    }
    const cmdline = screen.queryByRole("textbox", { name: "Command" }) ?? screen.queryByRole("combobox", { name: "Command" });
    if (cmdline) {
      await user.click(cmdline);
      await user.keyboard("{Escape}");
    }
    const keys = screen.queryByRole("complementary", { name: "Key bindings" });
    if (keys) await user.click(within(keys).getByRole("button", { name: "Close key bindings" }));
    const check = screen.queryByRole("button", { name: "Close the check" });
    if (check) await user.click(check);
    await user.keyboard("{Escape}");
    if (view() !== mode) {
      await user.keyboard(`${LEADER}:`);
      await user.keyboard(`mode ${mode}{Enter}`);
    }
    while (document.querySelectorAll(".pane").length < 2) await connect(user, h1);
    expect(view()).toBe(mode);
  }

  for (const mode of ["standard", "focus"] as const) {
    it(`every command runs in ${mode} mode, by its key and by : command`, async () => {
      const { registries, runs, wrapAll } = counted();
      const user = (await ready({ registries })).user;
      wrapAll();
      await reset(user, mode);
      const keymap = keymapOf(registries.keymap.list());
      const ids = registries.commands.list().map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining(["mode", "focus", "finder", "folder", "find", "close", "lock", "check"]));
      let byKey = 0;
      for (const c of registries.commands.list()) {
        const arg = argFor(c);
        const line = arg ? `${c.id} ${arg}` : c.id;
        await user.keyboard(`${LEADER}:`);
        const before = runs.get(c.id) ?? 0;
        await user.keyboard(`${line.replace(/[{[]/g, (x) => x + x)}{Enter}`);
        expect(runs.get(c.id) ?? 0, `:${line} in ${mode}`).toBe(before + 1);
        await reset(user, mode);

        const bound = [
          ...Object.entries(keymap.leader).map(([k, b]) => [`${LEADER}${keys(k)}`, b.action] as const),
          ...Object.entries(keymap.list).map(([k, b]) => [`${LEADER}${keys(k)}`, b.action] as const),
          ...Object.entries(keymap.listVim).map(([k, b]) => [`${LEADER}${keys(k)}`, b.action] as const),
          ...Object.entries(keymap.global).map(([k, b]) => [keys(k), b.action] as const),
        ].filter(([, action]) => action.split(" ")[0] === c.id);
        for (const [typed] of bound.slice(0, 1)) {
          const n = runs.get(c.id) ?? 0;
          await user.keyboard(typed);
          byKey++;
          expect(runs.get(c.id) ?? 0, `${typed} → ${c.id} in ${mode}`).toBe(n + 1);
          await reset(user, mode);
        }
      }
      // Every command with a default key was reached by it (the rest have none: connect HOST…).
      expect(byKey).toBeGreaterThanOrEqual(20);
    }, 60_000);
  }
});

/** A keymap sequence as user-event types it. */
function keys(seq: string): string {
  return seq
    .split(" ")
    .map((k) => {
      if (k === "[") return "[[";
      if (k.length === 1) return k;
      const [mod, key] = k.includes("+") ? k.split("+") : [null, k];
      const name = key === "Space" ? " " : key;
      return mod === "Ctrl" ? `{Control>}${name}{/Control}` : `{${name}}`;
    })
    .join("");
}
