// Ticket 40 (#52): the Topology view, plugins/topology, end to end in the app, installed as a
// Package from roster's repo with `dir` (`?fixture=topology`). The fake Backend runs its stand-in
// (backend/fakeTopology.ts, checked against the real Lua by plugins/topology.test.ts) against a
// stand-in roster serve for the Mesh. The Lua itself is tested in
// crates/roster-core/tests/plugin_topology.rs; serve's `mesh.status { grouped }` in tests/test_mesh.py.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import { fixtureProps } from "./backend/fixtureProps";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const WAIT = { timeout: 6000 };
const TEST = 20000;
const scenario = fixtures.topology as FakeScenario;
const hosts = scenario.hosts.hosts;
/** A reviewed Host that takes a key, in a meshed subnet. */
const meshed = hosts.find((h) => h.group === "subnet-1" && h.reviewed && h.enroll)?.name ?? "";
const loose = hosts.find((h) => h.group === "subnet-2" && !h.reviewed)?.name ?? "";

async function ready() {
  const user = userEvent.setup();
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} {...fixtureProps(scenario.app, memoryPlatform())} />);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const graph = () => screen.getByRole("application", { name: "Topology" });
const foot = () => document.querySelector(".graph-about")?.textContent ?? "";
const notice = (text: string | RegExp) => screen.findByText(text, { selector: ".config-toast-title" }, WAIT);

async function open(user: ReturnType<typeof userEvent.setup>, line = "topology") {
  // The first look is deferred: the view is there once the Plugin has looked.
  await waitFor(async () => {
    await user.keyboard(`${LEADER}:${line}{Enter}`);
    expect(screen.getByRole("region", { name: "Topology (from topology)" })).toBeInTheDocument();
  }, WAIT);
  return graph();
}

describe("the Topology view", () => {
  it(":topology opens the map of this Box and every Host by group, says the Mesh is out of date, and Esc goes back", async () => {
    const user = await ready();
    expect(await open(user)).toHaveFocus();
    const region = screen.getByRole("region", { name: "Topology (from topology)" });
    expect(region).toHaveTextContent(`${hosts.length} Hosts in 4 groups.`);
    expect(region).toHaveTextContent("The Mesh is out of date");
    expect(region).toHaveTextContent("Cut pending on 1 Host");
    // The Box is the first node: it reaches every Host.
    expect(foot()).toMatch(/^This Box, box, square\. Reaches \d+ nodes; reached by 0$/);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Topology (from topology)" })).toBeNull();
  }, TEST);

  it("lists every Host with its shape, state and reach, and the Mesh's clusters", async () => {
    const user = await ready();
    await open(user);
    await user.keyboard("t");
    const grid = screen.getByRole("grid", { name: "Topology: nodes" });
    const rows = within(grid).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(hosts.length + 1);
    const row = (name: string) => rows.find((r) => r.textContent?.startsWith(name)) as HTMLElement;
    expect(row(loose)).toHaveTextContent("dashed ring");
    // The two Sessions open at start are live.
    for (const name of scenario.app?.openAtStart ?? []) expect(row(name)).toHaveTextContent("live");
    // A meshed Host reaches the rest of its group, and what they reach.
    expect(row(meshed)).toHaveTextContent("subnet-1");
    // A long cluster name is cut in the middle (ticket 91): its cell holds it whole, in two parts.
    expect(within(grid).getAllByRole("gridcell").some((c) => /subnet-1 · password peers|subnet-1 · not in the Mesh/.test(c.textContent ?? ""))).toBe(true);
  }, TEST);

  it(":topology GROUP shows only that group, and :topology alone everything again", async () => {
    const user = await ready();
    await open(user, "topology subnet-2");
    const shown = hosts.filter((h) => h.group === "subnet-2").length;
    expect(screen.getByText(`Showing ${shown} of ${hosts.length + 1} nodes`)).toBeInTheDocument();
    // The group's clusters: its own, its password peers and those not in the Mesh.
    expect(screen.getByRole("button", { name: /^Show the cluster/ })).toHaveTextContent(/^\d+ clusters/);
    await user.keyboard("{Escape}{Escape}");
    await open(user);
    expect(screen.queryByText(/^Showing/)).toBeNull();
  }, TEST);

  it("c runs the app's own check of the selected Host", async () => {
    const user = await ready();
    await open(user);
    await user.keyboard(`/${meshed}{Enter}`);
    expect(foot()).toMatch(new RegExp(`^${meshed}`));
    await user.keyboard("c");
    expect(await screen.findByRole("region", { name: new RegExp(`Check.*${meshed}|${meshed}.*check`, "i") }, WAIT)).toBeInTheDocument();
  }, TEST);

  it("x cuts a Host from the Mesh only once its name is typed, with progress until it's done", async () => {
    const user = await ready();
    await open(user);
    await user.keyboard(`/${meshed}{Enter}x`);
    const dialog = await screen.findByRole("alertdialog", { name: new RegExp(`Cut ${meshed} from the Mesh\\?`) });
    expect(dialog).toHaveTextContent("Asked by topology");
    const button = within(dialog).getByRole("button", { name: "Cut" });
    expect(button).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), meshed);
    expect(button).toBeEnabled();
    await user.click(button);
    await notice(new RegExp(`topology: Cut ${meshed} from \\d+ Hosts\\.`));
  }, TEST);

  it(":tutor topology teaches the map on the demo's Hosts and its made-up Mesh, and each step ticks as you do it (#233)", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:tutor topology{Enter}`);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Demo Inventory" })).not.toBeNull(), WAIT);
    const help = await screen.findByRole("complementary", { name: "Help" }, WAIT);
    expect(within(help).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("Topology tutor");
    const step = (n: number) => help.querySelectorAll(".help-step")[n] as HTMLElement;
    const ticked = (n: number) => waitFor(() => expect(step(n), `step ${n}`).toHaveAttribute("data-done"), WAIT);
    expect(help.querySelectorAll(".help-step")).toHaveLength(6);

    // Lesson 1: the demo's map, with the demo's Mesh drawn (the demo's mesh.status, no real serve).
    await open(user);
    const region = () => screen.getByRole("region", { name: "Topology (from topology)" });
    await waitFor(() => expect(region()).toHaveTextContent("6 Hosts in 2 groups."), WAIT);
    await waitFor(() => expect(region()).toHaveTextContent("The Mesh: 4 Hosts, 7 Links."), WAIT);
    expect(region()).toHaveTextContent("1 Host didn't answer the last apply (Mesh pending).");
    await ticked(0);
    expect(step(1)).not.toHaveAttribute("data-done");
    await user.keyboard(`${LEADER}:topology demo-lab{Enter}`);
    expect(await screen.findByText("Showing 4 of 7 nodes", undefined, WAIT)).toBeInTheDocument();
    await ticked(1);

    // Lesson 2: from a node to its Host's details, then a Session to it.
    await user.keyboard(`${LEADER}:topology{Enter}`);
    await user.keyboard("/demo-03{Enter}i");
    await ticked(2);
    await open(user);
    await user.keyboard("/demo-03{Enter}{Enter}");
    await ticked(3);

    // Lesson 3: reach. demo-01's details count what it reaches; demo-05's say why it's pending.
    // The map is still open beside the Session, which has the keys: a click hands them back, and
    // the search still holds demo-03, so it's cleared first.
    const find = async (name: string) => {
      await user.keyboard("/");
      await user.clear(document.querySelector(".graph-search") as HTMLInputElement);
      await user.keyboard(`${name}{Enter}i`);
    };
    await user.click(await open(user));
    await find("demo-01");
    await ticked(4);
    expect(await screen.findByText("3 Hosts directly", undefined, WAIT)).toBeInTheDocument();
    await user.click(await open(user));
    await find("demo-05");
    await ticked(5);
    expect(await screen.findByText(/no answer: ssh: connect to host 10\.0\.0\.15 port 22/, undefined, WAIT)).toBeInTheDocument();
  }, TEST);
});
