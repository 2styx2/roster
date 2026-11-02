// Ticket 50 (#87): the Mesh controls, plugins/mesh, end to end in the app, installed as a Package
// from roster's repo with `dir` (`?fixture=mesh`). The fake Backend runs its stand-in
// (backend/fakeMesh.ts, checked against the real Lua by plugins/mesh.test.ts) against a stand-in
// roster serve for the Mesh's methods. The Lua itself is tested in
// crates/roster-core/tests/plugin_mesh.rs; serve's jobs in tests/test_mesh.py.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import { fixtureProps } from "./backend/fixtureProps";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const WAIT = { timeout: 6000 };
const TEST = 20000;
/** The row whose first cell is `name` (other rows' changes can name it too). */
const rowOf = (grid: HTMLElement, name: string) => within(grid).getAllByRole("row").find((r) => r.textContent?.startsWith(name));

async function ready() {
  const user = userEvent.setup();
  const scenario: FakeScenario = { ...fixtures.mesh!, mesh: { lab: 4, ticks: 1 } };
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} {...fixtureProps(scenario.app, memoryPlatform())} />);
  await screen.findByRole("main", { name: /workspace/i });
  // The first look at the Mesh, once the Plugin loaded: the status bar says it's out of date.
  await screen.findByText("Mesh out of date", undefined, WAIT);
  return user;
}

const notice = (text: string | RegExp) => screen.findByText(text, { selector: ".config-toast-title" }, WAIT);

describe("the Mesh controls", () => {
  it(":mesh shows each Host's reach and state, and explains a no-via Link", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:mesh{Enter}`);
    const grid = await screen.findByRole("grid", { name: "Mesh" });
    const row = rowOf(grid, "esx-02");
    expect(row).toHaveTextContent("3");
    expect(row).toHaveTextContent("in the Mesh");
    expect(rowOf(grid, "sw-1")).toHaveTextContent("kept out: mesh: false");
    expect(screen.getByText(/1 Link goes through a jump Host its source has no Link to \(no-via\)/)).toBeInTheDocument();
    await user.keyboard("l");
    const links = await screen.findByRole("grid", { name: "Mesh Links" });
    expect(rowOf(links, "orion-3")).toHaveTextContent("no Link to its hop");
    await user.keyboard("e");
    expect(await screen.findByText(/Add a Link from the source to the jump Host/)).toBeInTheDocument();
  }, TEST);

  it("plans with progress, shows the changes, and applies only after the question", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:mesh plan{Enter}`);
    expect(await screen.findByRole("progressbar", { name: "Planning the Mesh" })).toBeInTheDocument();
    await notice("mesh: Plan ready: 3 Hosts would change. Press a in :view mesh-plan to apply it.");
    const plan = await screen.findByRole("grid", { name: "Mesh plan" });
    const esx = rowOf(plan, "esx-02") as HTMLElement;
    expect(esx).toHaveTextContent("make key; write ssh config");
    // Focus is in the plan's table once it's there (ticket 91): `a` works without a click.
    expect(plan).toHaveFocus();
    await user.keyboard("a");
    const dialog = await screen.findByRole("alertdialog", { name: /Apply the Mesh\?/ });
    expect(dialog).toHaveTextContent("Asked by mesh");
    expect(dialog).toHaveTextContent("3 of 4");
    expect(within(dialog).getByRole("button", { name: "Apply" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await notice("mesh: Applied: 3 Hosts changed.");
    expect(screen.queryByText("Mesh out of date")).toBeNull();
  }, TEST);

  it("cuts a Host only once its name is typed, and warns about the Host that was down", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:mesh cut orion-2{Enter}`);
    const dialog = await screen.findByRole("alertdialog", { name: /Cut orion-2 from the Mesh\?/ });
    expect(dialog).toHaveTextContent("can reach 3 Hosts");
    const cut = within(dialog).getByRole("button", { name: "Cut" });
    expect(cut).toBeDisabled();
    expect(cut).toHaveClass("danger");
    await user.keyboard("orion-2");
    expect(cut).toBeEnabled();
    await user.keyboard("{Enter}");
    await notice(/mesh: CUT PENDING on nas-1: no answer/);
    expect(await screen.findByText("Cut pending", undefined, WAIT)).toBeInTheDocument();
  }, TEST);

  it("each Host's details have a Mesh section with its reach", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:info esx-02{Enter}`);
    expect(await screen.findByText("can reach 3 Hosts", undefined, WAIT)).toBeInTheDocument();
  }, TEST);

  it("a Host's Mesh section lists only its Links, and x there asks to Cut it, as its heading's button does (#176)", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:info esx-02{Enter}`);
    await screen.findByText("can reach 3 Hosts", undefined, WAIT);
    const section = screen.getByRole("region", { name: "Mesh (from mesh)" });
    expect(within(section).queryByText("this Host")).toBeNull();
    const button = within(section).getByRole("button", { name: "Cut esx-02 from the Mesh" });
    expect(button).toHaveAttribute("aria-keyshortcuts", "x");
    (within(section).queryByRole("grid") ?? button).focus();
    await user.keyboard("x");
    expect(await screen.findByRole("alertdialog", { name: /Cut esx-02 from the Mesh\?/ })).toBeInTheDocument();
  }, TEST);
});
