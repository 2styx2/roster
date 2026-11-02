// Sessions, listed in the Sidebar, through the App with the fake Backend and a stub terminal (xterm itself
// isn't run in jsdom; its key filter is tested in terminal/keys.test.ts).
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { FAKE_PASSWORD, fakeBackend, fixtures, makeHosts } from "../backend/fake";
import { StubTerminal } from "../terminal/StubTerminal";

const hosts = makeHosts(12);
const reviewed = hosts.hosts.filter((h) => h.reviewed);

async function ready(scenario = { hosts }) {
  const user = userEvent.setup();
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} />);
  await screen.findByText(/12 hosts/i);
  await unlock(user);
  return user;
}

async function unlock(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
}

async function openFromPicker(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.keyboard("{Control>} {/Control}f");
  await user.keyboard(name);
  await user.keyboard("{Enter}");
}

const sidebar = () => screen.getByRole("group", { name: "Sessions" });
const current = () => within(sidebar()).getByRole("treeitem", { current: true });

const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });

describe("Sessions", () => {
  it("Enter in the Picker opens the Host in a new Session with its terminal focused", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(current()).toHaveAccessibleName(new RegExp(`^${reviewed[0]!.name}`));
    expect(await within(output()).findByText(/Connected to/)).toBeInTheDocument();
    expect(document.activeElement).toHaveAccessibleName("terminal input");
  });

  it("sends every key to the shell, Esc included, but not the Leader", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await within(output()).findByText(/Connected to/);
    await user.keyboard("vi{Escape}");
    expect(output()).toHaveTextContent(/vi\^\[$/);
    await user.keyboard("{Control>} {/Control}f");
    expect(screen.getByRole("dialog", { name: /find a host/i })).toBeInTheDocument();
    expect(output().textContent).not.toMatch(/\0|f$/);
  });

  it("goes back to the terminal when the Picker is closed with Esc", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await user.keyboard("{Control>} {/Control}f{Escape}");
    expect(document.activeElement).toHaveAccessibleName("terminal input");
  });

  it("switches and closes Sessions, ending the Session", async () => {
    const user = await ready();
    const [a, b] = [reviewed[0]!.name, reviewed[1]!.name];
    await openFromPicker(user, a);
    await openFromPicker(user, b);
    expect(current()).toHaveAccessibleName(new RegExp(`^${b}`));
    await user.click(within(sidebar()).getByRole("treeitem", { name: new RegExp(`^${a}`) }));
    expect(current()).toHaveAccessibleName(new RegExp(`^${a}`));
    await user.click(screen.getByRole("button", { name: `Close ${a}` }));
    expect(current()).toHaveAccessibleName(new RegExp(`^${b}`));
    await user.click(screen.getByRole("button", { name: `Close ${b}` }));
    expect(within(sidebar()).queryByRole("treeitem", { current: true })).toBeNull();
    expect(within(screen.getByRole("main")).getByText(/No Sessions open/)).toBeInTheDocument();
  });

  it("shows roster's refusal inline in the Session", async () => {
    const user = await ready(fixtures["not-set-up"]!);
    await openFromPicker(user, reviewed[0]!.name);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/isn't in this box's ssh config/);
    expect(alert).toHaveTextContent(/roster sync/);
  });

  it("shows that a Session ended, with its exit code", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await within(output()).findByText(/Connected to/);
    await user.keyboard("exit{Enter}");
    expect(await within(sidebar()).findByRole("treeitem", { name: /ended \(code 0\)/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: `Session ${reviewed[0]!.name}` })).toHaveTextContent("ended (code 0)");
  });

  it("an ended tab says so, and the Leader then r reconnects it", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await within(output()).findByText(/Connected to/);
    await user.keyboard("exit{Enter}");
    const panel = await screen.findByRole("group", { name: `Session ${reviewed[0]!.name}` });
    await within(panel).findByText(/ended \(code 0\)/);
    expect(within(panel).getByTitle(/Leader \(Ctrl\+Space\)/)).toBeInTheDocument();
    await user.keyboard("{Control>} {/Control}r");
    expect(await within(sidebar()).findByRole("treeitem", { name: new RegExp(`^${reviewed[0]!.name},`) })).toBeInTheDocument();
    expect(within(panel).queryByText(/ended/)).toBeNull();
    expect(output().textContent).toMatch(/exit\r?\n.*reconnecting.*Connected to/s);
    expect(within(sidebar()).getAllByRole("treeitem", { current: true })).toHaveLength(1);
    expect(within(sidebar()).getAllByRole("treeitem", { name: /^(?!Sessions$)/ })).toHaveLength(1);
  });

  it("an ended tab reconnects with its button too", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await within(output()).findByText(/Connected to/);
    await user.keyboard("exit{Enter}");
    await user.click(await screen.findByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(output().textContent).toMatch(/reconnecting.*Connected to/s));
    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
  });

  it("the Leader then r does nothing to a Session that's still open", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await within(output()).findByText(/Connected to/);
    await user.keyboard("{Control>} {/Control}r");
    expect(output().textContent).not.toMatch(/reconnecting/);
    expect(output().textContent).not.toMatch(/r$/);
  });

  it("a refused tab can be retried", async () => {
    const scenario = { ...fixtures["not-set-up"]! };
    const user = await ready(scenario);
    await openFromPicker(user, reviewed[0]!.name);
    await screen.findByRole("alert");
    delete scenario.sessionRefusal;
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await within(output()).findByText(/Connected to/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Ctrl+Enter in the Picker connects in the current tab when its Session has ended", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await within(output()).findByText(/Connected to/);
    await user.keyboard("exit{Enter}");
    await within(sidebar()).findByRole("treeitem", { name: /ended/ });
    await user.keyboard("{Control>} {/Control}f");
    await user.keyboard(reviewed[1]!.name);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await within(sidebar()).findByRole("treeitem", { name: new RegExp(`^${reviewed[1]!.name},`) })).toBeInTheDocument();
    expect(within(sidebar()).getAllByRole("treeitem", { name: /^(?!Sessions$)/ })).toHaveLength(1);
    await waitFor(() => expect(output().textContent).toContain(`Connected to ${reviewed[1]!.name}`));
  });

  it("Ctrl+Enter in the Picker opens a new tab when the current Session is still open", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await user.keyboard("{Control>} {/Control}f");
    await user.keyboard(reviewed[1]!.name);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(within(sidebar()).getAllByRole("treeitem", { name: /^(?!Sessions$)/ })).toHaveLength(2);
  });

  it("opens several Sessions to the same Host", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await openFromPicker(user, reviewed[0]!.name);
    expect(within(sidebar()).getAllByRole("treeitem", { name: /^(?!Sessions$)/ }).map((t) => t.textContent)).toEqual([
      expect.stringContaining(reviewed[0]!.name),
      expect.stringContaining(`${reviewed[0]!.name} (2)`),
    ]);
  });

  it("hides open Sessions while locked; they keep running and come back on unlock", async () => {
    const user = await ready();
    await openFromPicker(user, reviewed[0]!.name);
    await within(output()).findByText(/Connected to/);
    await user.keyboard("{Control>} {/Control}L");
    expect(await screen.findByRole("dialog", { name: /locked/i })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
    // Keys typed while locked go to the lock screen, never to the shell.
    await user.type(screen.getByLabelText(/master password/i), "typed-while-locked{Enter}");
    await screen.findByText(/wrong master password/i);
    await unlock(user);
    expect(current()).toHaveAccessibleName(new RegExp(`^${reviewed[0]!.name},`));
    expect(output()).toHaveTextContent(/Connected to/);
    expect(output().textContent).not.toMatch(/typed-while-locked/);
  });
});

describe("the tab strip's breadcrumb (ticket 120)", () => {
  it("names the Host a nested ssh took the Session to, for the eye and for a screen reader", async () => {
    const { TabStrip } = await import("./Sessions");
    const tab = (hop: { to: string; known: boolean } | null) => ({
      id: 1,
      host: "esx-01",
      label: "esx-01",
      status: { state: "open" as const },
      auth: "key" as const,
      shell: true,
      attempt: 1,
      quick: null,
      save: null,
      prompt: null,
      hop,
    });
    const { rerender } = render(<TabStrip snapshot={{ tabs: [tab({ to: "esx-02", known: true })], active: 1, previous: null }} run={() => {}} />);
    expect(screen.getByRole("tab")).toHaveAccessibleName("esx-01, now on esx-02 through ssh");
    rerender(<TabStrip snapshot={{ tabs: [tab(null)], active: 1, previous: null }} run={() => {}} />);
    expect(screen.getByRole("tab")).toHaveAccessibleName("esx-01");
  });
});
