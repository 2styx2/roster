// The keyboard model and the Sidebar (ticket 07), through the App with the fake Backend and a
// stub terminal. user-event writes "[" as "[[" and Ctrl+Space as {Control>} {/Control}.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { defaultOptions, registerBindings, type KeymapOverrides, type Options } from "./keymap";
import { builtinRegistries } from "./registries";
import { CONFIG } from "./registry";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const reviewed = hosts.hosts.filter((h) => h.reviewed).map((h) => h.name);
const [h0, h1, h2] = reviewed as [string, string, string];
const LEADER = "{Control>} {/Control}";

/** The app opens locked (ticket 04). */
async function unlock(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
}

async function ready(props: { options?: Partial<Options>; bindings?: KeymapOverrides } = {}) {
  const user = userEvent.setup();
  const registries = builtinRegistries();
  if (props.bindings) registerBindings(registries.keymap, props.bindings, CONFIG);
  render(
    <App
      backend={fakeBackend({ hosts })}
      terminalView={StubTerminal}
      options={{ ...defaultOptions, ...props.options }}
      registries={registries}
    />,
  );
  await screen.findByText(/12 hosts/i);
  await unlock(user);
  return user;
}

async function connect(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.keyboard(`${LEADER}f`);
  await user.keyboard(name);
  await user.keyboard("{Enter}");
  await within(output()).findByText(new RegExp(`Connected to ${name}`));
}

const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
const sessionList = () => screen.getByRole("group", { name: "Sessions" });
const row = (name: string) => within(sessionList()).getByRole("treeitem", { name: new RegExp(`^${name}`) });
const current = () => within(sessionList()).getByRole("treeitem", { current: true });
const appMode = () => screen.queryByText("APP") !== null;

describe("Terminal mode and App mode", () => {
  it("the Leader enters App mode, where keys never reach the shell; Esc goes back", async () => {
    const user = await ready();
    await connect(user, h0);
    expect(appMode()).toBe(false);
    await user.keyboard(`${LEADER}`);
    expect(appMode()).toBe(true);
    await user.keyboard("xq");
    expect(output().textContent).not.toMatch(/[xq]$/);
    await user.keyboard("{Escape}");
    expect(appMode()).toBe(false);
    await user.keyboard("ok");
    expect(output()).toHaveTextContent(/ok$/);
    expect(document.activeElement).toHaveAccessibleName("terminal input");
  });

  it("goes back to the terminal after a one-shot binding", async () => {
    const user = await ready();
    await connect(user, h0);
    await connect(user, h1);
    await user.keyboard(`${LEADER}[[`);
    expect(appMode()).toBe(false);
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
    await user.keyboard("hi");
    expect(output()).toHaveTextContent(/hi$/);
  });

  it("works with another Leader", async () => {
    const user = await ready({ options: { leader: "Ctrl+b" } });
    await user.keyboard(`${LEADER}f`);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Control>}b{/Control}f");
    expect(screen.getByRole("dialog", { name: /find a host/i })).toBeInTheDocument();
  });
});

describe("The Sidebar", () => {
  it("lists the open Sessions with the one on screen raised, and no tab strip", async () => {
    const user = await ready();
    expect(within(sessionList()).getByText(/No Sessions open/)).toBeInTheDocument();
    await connect(user, h0);
    await connect(user, h1);
    expect(within(sessionList()).getAllByRole("treeitem", { name: /^(?!Sessions$)/ })).toHaveLength(2);
    expect(current()).toHaveAccessibleName(new RegExp(`^${h1}`));
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("switches and closes Sessions with the mouse", async () => {
    const user = await ready();
    await connect(user, h0);
    await connect(user, h1);
    await user.click(row(h0));
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
    expect(output()).toHaveTextContent(`Connected to ${h0}`);
    expect(document.activeElement).toHaveAccessibleName("terminal input");
    await user.click(within(sessionList()).getByRole("button", { name: `Close ${h0}` }));
    expect(current()).toHaveAccessibleName(new RegExp(`^${h1}`));
    await user.click(within(sessionList()).getByRole("button", { name: `Close ${h1}` }));
    expect(within(sessionList()).getByText(/No Sessions open/)).toBeInTheDocument();
  });

  it("switches Sessions by key: next, previous, by number, and j/k then Enter", async () => {
    const user = await ready();
    for (const h of [h0, h1, h2]) await connect(user, h);
    await user.keyboard(`${LEADER}]`);
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
    await user.keyboard(`${LEADER}2`);
    expect(current()).toHaveAccessibleName(new RegExp(`^${h1}`));
    await user.keyboard(`${LEADER}j`);
    expect(row(h2).closest("li")).toHaveClass("cursor");
    expect(current()).toHaveAccessibleName(new RegExp(`^${h1}`));
    await user.keyboard("kk{Enter}");
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
    expect(appMode()).toBe(false);
    expect(output()).toHaveTextContent(`Connected to ${h0}`);
  });

  it("closes the current Session with ␣ d d", async () => {
    const user = await ready();
    await connect(user, h0);
    await connect(user, h1);
    await user.keyboard(`${LEADER}dd`);
    expect(within(sessionList()).queryByRole("treeitem", { name: new RegExp(`^${h1}`) })).toBeNull();
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
    expect(document.activeElement).toHaveAccessibleName("terminal input");
  });

  it("with vim off, j and k do nothing special, arrows still move, and the mouse still works", async () => {
    const user = await ready({ options: { vim: false } });
    await connect(user, h0);
    await connect(user, h1);
    await user.keyboard(`${LEADER}k`);
    expect(row(h1).closest("li")).toHaveClass("cursor");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
    await user.click(row(h1));
    expect(current()).toHaveAccessibleName(new RegExp(`^${h1}`));
  });

  it("hides and shows with ␣ e, and starts hidden when the options say so", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}e`);
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
    await user.keyboard(`${LEADER}e`);
    expect(screen.getByRole("navigation", { name: "Sidebar" })).toBeInTheDocument();
  });

  it("starts hidden when the options say so", async () => {
    await ready({ options: { sidebar: { visible: false, side: "left" } } });
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
  });

  it("lists Sessions in a basic tab strip instead with sessions = tabs", async () => {
    const user = await ready({ options: { sessions: "tabs" } });
    await connect(user, h0);
    await connect(user, h1);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard(`${LEADER}1`);
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("group", { name: "Sessions" })).toBeNull();
  });
});

describe("The status bar", () => {
  it("hides and shows with ␣ s, and starts hidden when the options say so", async () => {
    const user = await ready();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    await user.keyboard(`${LEADER}s`);
    expect(screen.queryByRole("contentinfo")).toBeNull();
    await user.keyboard(`${LEADER}s`);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("starts hidden when the options say so", async () => {
    const user = userEvent.setup();
    render(
      <App
        backend={fakeBackend({ hosts })}
        terminalView={StubTerminal}
        options={{ ...defaultOptions, statusBar: { visible: false } }}
      />,
    );
    await unlock(user);
    expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).toBeNull();
  });
});

describe("The command line", () => {
  const cmdline = () => screen.getByRole("combobox", { name: "Command" });

  it("completes commands and Host names, then connects", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:`);
    expect(cmdline()).toHaveFocus();
    // The common prefix of connect and config first, as a shell does; then the first of them.
    await user.keyboard("co{Tab}");
    expect(cmdline()).toHaveValue("con");
    await user.keyboard("{Tab}");
    expect(cmdline()).toHaveValue("connect ");
    await user.keyboard(`${h0.slice(0, -1)}{Tab}`);
    expect(cmdline()).toHaveValue(`connect ${h0}`);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("combobox", { name: "Command" })).toBeNull();
    expect(await within(output()).findByText(new RegExp(`Connected to ${h0}`))).toBeInTheDocument();
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
  });

  it("shows the candidates and cycles through them with Tab", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:c`);
    // List motions (choose) come last (ticket 29 S8).
    expect(screen.getAllByRole("option").map((o) => o.querySelector(".cmd-id")?.textContent)).toEqual([
      "changes",
      "check",
      "close",
      "cmdline",
      "connect ",
      "cancel",
      "config",
      "choose",
    ]);
    await user.keyboard("{Tab}{Tab}{Tab}{Tab}{Tab}");
    expect(cmdline()).toHaveValue("connect ");
  });

  it("closes the current Session with :close", async () => {
    const user = await ready();
    await connect(user, h0);
    await user.keyboard(`${LEADER}:close{Enter}`);
    expect(within(sessionList()).getByText(/No Sessions open/)).toBeInTheDocument();
  });

  it("says what's wrong, and won't connect to an unknown or unreviewed Host", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:conect x{Enter}`);
    expect(screen.getByRole("status")).toHaveTextContent("Not a command: conect");
    await user.keyboard(`${LEADER}:connect nope{Enter}`);
    expect(screen.getByRole("status")).toHaveTextContent("No Host named nope");
    const unreviewed = hosts.hosts.find((h) => !h.reviewed)!.name;
    await user.keyboard(`${LEADER}:connect ${unreviewed}{Enter}`);
    expect(screen.getByRole("status")).toHaveTextContent(/isn't reviewed/);
    expect(within(sessionList()).getByText(/No Sessions open/)).toBeInTheDocument();
  });

  it("Esc closes it and gives the keys back to the terminal", async () => {
    const user = await ready();
    await connect(user, h0);
    await user.keyboard(`${LEADER}:clo{Escape}`);
    expect(screen.queryByRole("combobox", { name: "Command" })).toBeNull();
    expect(document.activeElement).toHaveAccessibleName("terminal input");
    expect(appMode()).toBe(false);
  });
});

describe("Lock, by every path (one command)", () => {
  const locked = () => screen.findByRole("dialog", { name: /locked/i });

  it.each([
    ["␣ L", (user: ReturnType<typeof userEvent.setup>) => user.keyboard(`${LEADER}L`)],
    [":lock", (user: ReturnType<typeof userEvent.setup>) => user.keyboard(`${LEADER}:lock{Enter}`)],
    ["the Sidebar's button", (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Lock" }))],
  ])("locks with %s", async (_, how) => {
    const user = await ready();
    await connect(user, h0);
    await how(user);
    expect(await locked()).toBeInTheDocument();
    await unlock(user);
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
  });
});

describe("The Key bindings panel", () => {
  const panel = () => screen.getByRole("complementary", { name: "Key bindings" });
  const rowOf = (label: string) =>
    within(panel())
      .getAllByRole("row")
      .filter((r) => !r.classList.contains("group") && r.textContent?.includes(label));

  it("lists the resolved keymap with where each binding comes from, and filters", async () => {
    const user = await ready({ bindings: { leader: { t: "next" } } });
    await user.keyboard(`${LEADER}K`);
    const next = rowOf("Next Session");
    expect(next.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Next Session.*Leader.*\]$/),
      expect.stringMatching(/Next Session.*Leader.*t.*init\.lua/),
    ]);
    // A built-in binding doesn't say "builtin" (ticket 29 N1); only another source is named.
    expect(rowOf("Leader")[0]).toHaveTextContent(/Ctrl\+Space$/);
    expect(within(panel()).getByRole("searchbox", { name: /filter/i })).toHaveFocus();
    await user.keyboard("close the s");
    const shown = within(panel()).getAllByRole("row").filter((r) => !r.classList.contains("group"));
    expect(shown.map((r) => r.textContent)).toEqual([expect.stringMatching(/Close the Session/)]);
  });

  it("shows a changed Leader as coming from the Config", async () => {
    const user = await ready({ options: { leader: "Ctrl+b" } });
    await user.keyboard("{Control>}b{/Control}K");
    expect(rowOf("Leader")[0]).toHaveTextContent(/Ctrl\+b.*init\.lua/);
  });

  it("closes with Esc or ␣ K again, and opens with the mouse", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}K{Escape}`);
    expect(screen.queryByRole("complementary", { name: "Key bindings" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(panel()).toBeInTheDocument();
    await user.keyboard(`${LEADER}K`);
    expect(screen.queryByRole("complementary", { name: "Key bindings" })).toBeNull();
  });
});

describe("Registries (ADR 0006)", () => {
  it("shows a Sidebar section another source registers, and its rows run commands", async () => {
    const user = userEvent.setup();
    const registries = builtinRegistries();
    registries.sidebar.register({
      id: "pinned",
      source: "init.lua",
      order: 200,
      build: () => ({ id: "pinned", title: "Pinned", rows: [{ id: "pin-0", label: h2, command: `connect ${h2}` }] }),
    });
    render(<App backend={fakeBackend({ hosts })} terminalView={StubTerminal} registries={registries} />);
    await unlock(user);
    const pinned = await screen.findByRole("group", { name: "Pinned" });
    await user.click(within(pinned).getByRole("treeitem", { name: h2 }));
    expect(await within(output()).findByText(new RegExp(`Connected to ${h2}`))).toBeInTheDocument();
  });

  it("runs a command the Config adds, by key and by the command line, and lists it in the panel", async () => {
    const user = userEvent.setup();
    const registries = builtinRegistries();
    registries.commands.register({
      id: "home",
      source: "init.lua",
      area: "Hosts",
      label: () => "Home box",
      run: (ctx) => ctx.connect(h0),
    });
    registerBindings(registries.keymap, { leader: { h: "home" } }, CONFIG);
    render(<App backend={fakeBackend({ hosts })} terminalView={StubTerminal} registries={registries} />);
    await unlock(user);
    await user.keyboard(`${LEADER}h`);
    expect(await within(output()).findByText(new RegExp(`Connected to ${h0}`))).toBeInTheDocument();
    await user.keyboard(`${LEADER}:home{Enter}`);
    expect(within(sessionList()).getAllByRole("treeitem", { name: new RegExp(`^${h0}`) })).toHaveLength(2);
    await user.keyboard(`${LEADER}K`);
    const panel = screen.getByRole("complementary", { name: "Key bindings" });
    expect(within(panel).getByText("Home box").closest("tr")).toHaveTextContent(/Leader\s*h.*init\.lua/);
  });
});

describe("Sidebar state dots", () => {
  it("shows a key dot for an enrolled Host even when its Login points at the vault, and password otherwise", async () => {
    const enrolled = { ...hosts.hosts.find((h) => h.reviewed && h.enroll)!, ssh: { user: "root", port: 22, auth: "bw:x ssh" } };
    const pw = hosts.hosts.find((h) => h.reviewed && !h.enroll)!;
    const user = userEvent.setup();
    const list = { ...hosts, hosts: hosts.hosts.map((h) => (h.name === enrolled.name ? enrolled : h)) };
    render(<App backend={fakeBackend({ hosts: list })} terminalView={StubTerminal} />);
    await unlock(user);
    await connect(user, enrolled.name);
    await connect(user, pw.name);
    const dot = (name: string) => row(name).querySelector(".dot");
    expect(dot(enrolled.name)).toHaveClass("key");
    expect(dot(pw.name)).toHaveClass("password");
  });
});
