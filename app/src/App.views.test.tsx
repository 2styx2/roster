// Plugin views, tables and Host-details sections (ticket 76, decision Q95) through the App, with
// the fake Backend's Plugin host: a view opens by command, key, the views finder and the Plugin's
// own command; Esc puts focus back; a table sorts, moves with vim keys, runs its actions on the
// selected row and takes updates in place; 600 rows draw only a screenful; a Plugin's section
// shows in a Host's details.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import type { FakePlugin } from "./backend/fakePlugins";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const PATH = "~/plugins/scan";

/** A Discover-like Plugin: a view with a table it fills, an action that keeps a row, and a section
 * in each found Host's details. */
function scanPlugin(count = 3, place: "panel" | "full" = "panel"): FakePlugin {
  return {
    manifest: { name: "scan", version: "1.0.0", description: "Scans", author: "A. Author", api: 2, permissions: [] },
    load(roster) {
      const rows = Array.from({ length: count }, (_, i) => ({ id: `10.0.0.${i + 1}`, cells: { address: `10.0.0.${i + 1}`, ports: ((i + 1) * 3) % 4, state: "new" } }));
      roster.views.set("scan", {
        title: "Scan",
        place,
        actions: [{ label: "Scan again", key: "R", icon: "plan", run: (e: Record<string, unknown>) => roster.notify(`again for ${String(e.view)}`) }],
        text: "Found on 10.0.0.0/24.",
        table: {
          columns: [
            { id: "address", label: "Address", kind: "data" },
            { id: "ports", label: "Ports", kind: "number" },
            { id: "state", label: "State" },
          ],
          rows,
          empty: "Nothing found yet.",
          open: (e: Record<string, unknown>) => roster.notify(`opened ${String(e.row)}`),
          actions: [
            {
              label: "Keep",
              key: "a",
              run: (e: Record<string, unknown>) => roster.views.update("scan", { rows: [{ id: e.row, cells: { address: e.row, ports: 0, state: "kept" } }] }),
            },
          ],
        },
      });
      roster.keymap.set("leader", "y v", "view scan");
      roster.commands.add("scan", { desc: "Scan", run: () => roster.views.open("scan") });
      roster.commands.add("scan-clear", { desc: "Clear", run: () => roster.views.update("scan", { clear: true, rows: [{ id: "10.0.0.9", cells: { address: "10.0.0.9", ports: 1, state: "new" } }] }) });
      roster.commands.add("scan-at", { desc: "Open at", run: (a: Record<string, unknown>) => roster.views.open("scan", { select: String(a.args) }) });
      roster.commands.add("scan-done", { desc: "Done", run: () => roster.views.close("scan") });
      // A background job that ends says so with a button that opens its view (ticket 91).
      roster.commands.add("scan-finish", { desc: "Finish", run: () => roster.notify("Scan done", "info", { actions: [{ label: "Show the scan", run: "view scan" }] }) });
      roster.details.set("ports", "linux-1-000", {
        title: "Open ports",
        actions: [{ label: "Forget linux-1-000", key: "F", icon: "cut", run: (e: Record<string, unknown>) => roster.notify(`forget ${String(e.section)} of ${String(e.host)}`) }],
        facts: [{ label: "seen", value: "2 ports", data: true }],
        table: { columns: [{ id: "port", label: "Port", kind: "number" }], rows: [{ id: "22", cells: { port: 22 } }] },
      });
    },
  };
}

async function ready(plugin: FakePlugin = scanPlugin()) {
  const user = userEvent.setup();
  const backend = fakeBackend({ hosts: makeHosts(12), plugins: { [PATH]: plugin } });
  render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  await user.keyboard(`${LEADER}:plugins install ${PATH}{Enter}`);
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
  await screen.findByText("12 Hosts");
  return user;
}

const grid = () => screen.getByRole("grid", { name: "Scan" });
const selectedRow = () => within(grid()).getAllByRole("row").find((r) => r.getAttribute("aria-selected") === "true");

describe("a Plugin's view", () => {
  it(":view scan opens it as a side panel with its text and table; Esc closes it and focus goes back", async () => {
    const user = await ready();
    const before = document.activeElement;
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    const view = await screen.findByRole("region", { name: "Scan (from scan)" });
    expect(view).toHaveClass("view-panel");
    expect(view).toHaveTextContent("Found on 10.0.0.0/24.");
    expect(grid()).toHaveFocus();
    expect(within(grid()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Address", "Ports", "State", ""]);
    expect(selectedRow()).toHaveTextContent("10.0.0.1");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Scan (from scan)" })).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("opens from its Leader key, the views finder and the Plugin's own command; the Plugin can close it", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}yv`);
    expect(await screen.findByRole("grid", { name: "Scan" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:view{Enter}`);
    const finder = await screen.findByRole("dialog", { name: "Open a view" });
    expect(finder).toHaveTextContent("Scan");
    // `:messages`'s view is listed too (ticket 111).
    await user.keyboard("Scan{Enter}");
    expect(await screen.findByRole("grid", { name: "Scan" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:scan{Enter}`);
    expect(await screen.findByRole("grid", { name: "Scan" })).toBeInTheDocument();
    await user.keyboard(`${LEADER}:scan-done{Enter}`);
    await screen.findByText("12 Hosts");
    expect(screen.queryByRole("grid", { name: "Scan" })).toBeNull();
  });

  it("roster.views.open with select opens the table at that row (T99)", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:scan-at 10.0.0.3{Enter}`);
    expect(await screen.findByRole("grid", { name: "Scan" })).toHaveFocus();
    expect(selectedRow()).toHaveTextContent("10.0.0.3");
    await user.keyboard(`${LEADER}:scan-at 10.0.0.2{Enter}`);
    await waitFor(() => expect(selectedRow()).toHaveTextContent("10.0.0.2"));
  });

  it("a full view lies over the whole window", async () => {
    const user = await ready(scanPlugin(3, "full"));
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    expect(await screen.findByRole("region", { name: "Scan (from scan)" })).toHaveClass("view-full");
  });

  it("a notice's button opens the view: the click is the user's call (ticket 91)", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:scan-finish{Enter}`);
    const notice = await screen.findByRole("status", { name: "From scan" });
    expect(notice).toHaveTextContent("scan: Scan done");
    await user.click(within(notice).getByRole("button", { name: "Show the scan" }));
    expect(await screen.findByRole("grid", { name: "Scan" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "From scan" })).toBeNull();
  });

  it("says so for a view that isn't there", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:view nope{Enter}`);
    expect(await screen.findByText("There's no view nope: :view lists them")).toBeInTheDocument();
  });
});

describe("a table", () => {
  it("moves with j/k and g g/G, sorts with s and S and a heading's click, keeping the selected row", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    await screen.findByRole("grid", { name: "Scan" });
    await user.keyboard("jj");
    expect(selectedRow()).toHaveTextContent("10.0.0.3");
    await user.keyboard("gg");
    expect(selectedRow()).toHaveTextContent("10.0.0.1");
    await user.keyboard("G");
    expect(selectedRow()).toHaveTextContent("10.0.0.3");
    // s: by Address, then by Ports; S reverses. The selection stays on its row.
    await user.keyboard("ss");
    const ports = within(grid()).getByRole("columnheader", { name: /Ports/ });
    expect(ports).toHaveAttribute("aria-sort", "ascending");
    expect(within(grid()).getAllByRole("row").slice(1).map((r) => r.textContent?.slice(0, 8))).toEqual(["10.0.0.3", "10.0.0.2", "10.0.0.1"]);
    expect(selectedRow()).toHaveTextContent("10.0.0.3");
    await user.keyboard("S");
    expect(ports).toHaveAttribute("aria-sort", "descending");
    await user.click(within(grid()).getByRole("button", { name: /Address/ }));
    expect(within(grid()).getByRole("columnheader", { name: /Address/ })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByText(/3 rows, by Address/)).toBeInTheDocument();
  });

  it("an action's key runs it on the selected row, and the Plugin's update changes that row in place", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    await screen.findByRole("grid", { name: "Scan" });
    await user.keyboard("j");
    expect(within(selectedRow() as HTMLElement).getByRole("button", { name: "Keep" })).toBeInTheDocument();
    await user.keyboard("a");
    expect(await within(grid()).findByText("kept")).toBeInTheDocument();
    expect(selectedRow()).toHaveTextContent("10.0.0.2");
    expect(selectedRow()).toHaveTextContent("kept");
    expect(within(grid()).getAllByRole("row")).toHaveLength(4);
    // Enter runs the table's open with the row.
    await user.keyboard("{Enter}");
    expect(await screen.findByText("scan: opened 10.0.0.2")).toBeInTheDocument();
  });

  it("clear takes every row away in one update, and its rows fill it again (ticket 91)", async () => {
    const user = await ready(scanPlugin(600));
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    await screen.findByRole("grid", { name: "Scan" });
    await user.keyboard(`${LEADER}:scan-clear{Enter}`);
    expect(await screen.findByText("1 row")).toBeInTheDocument();
    expect(grid()).toHaveTextContent("10.0.0.9");
  });

  it("a click selects a row and shows its buttons; the button runs the action", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    await screen.findByRole("grid", { name: "Scan" });
    await user.click(within(grid()).getByText("10.0.0.3"));
    expect(selectedRow()).toHaveTextContent("10.0.0.3");
    await user.click(within(selectedRow() as HTMLElement).getByRole("button", { name: "Keep" }));
    expect(await within(grid()).findByText("kept")).toBeInTheDocument();
  });

  it("holds 600 rows drawing only a screenful, and G reaches the last", async () => {
    const user = await ready(scanPlugin(600));
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    await screen.findByRole("grid", { name: "Scan" });
    expect(grid()).toHaveAttribute("aria-rowcount", "601");
    expect(within(grid()).getAllByRole("row").length).toBeLessThan(80);
    expect(screen.getByText(/600 rows/)).toBeInTheDocument();
    await user.keyboard("G");
    const last = selectedRow() as HTMLElement;
    expect(last).toHaveTextContent("10.0.0.600");
    expect(last).toHaveAttribute("aria-rowindex", "601");
    expect(grid()).toHaveAttribute("aria-activedescendant", last.id);
  });
});

describe("a Plugin's section in Host details", () => {
  it("shows in its Host's details, after roster's, with its facts and table; not in another Host's", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:info linux-1-000{Enter}`);
    const details = await screen.findByRole("complementary", { name: "Details of linux-1-000" });
    const section = within(details).getByRole("region", { name: "Open ports (from scan)" });
    expect(section).toHaveTextContent("2 ports");
    expect(within(section).getByRole("grid", { name: "Open ports of linux-1-000" })).toHaveTextContent("22");
    await user.keyboard(`${LEADER}:info nas-4-007{Enter}`);
    const other = await screen.findByRole("complementary", { name: "Details of nas-4-007" });
    expect(within(other).queryByRole("region", { name: /Open ports/ })).toBeNull();
  });

  it("a view's and a section's heading buttons run with the view, or the section and its Host (ticket 91)", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    const view = await screen.findByRole("region", { name: "Scan (from scan)" });
    await user.click(within(view).getByRole("button", { name: "Scan again" }));
    expect(await screen.findByText("scan: again for scan")).toBeInTheDocument();
    await user.keyboard(`${LEADER}:info linux-1-000{Enter}`);
    const section = within(await screen.findByRole("complementary", { name: "Details of linux-1-000" })).getByRole("region", { name: "Open ports (from scan)" });
    await user.click(within(section).getByRole("button", { name: "Forget linux-1-000" }));
    expect(await screen.findByText("scan: forget ports of linux-1-000")).toBeInTheDocument();
  });

  it("a heading button's key runs it from anywhere in its view or section, and says so on the button (#176)", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    const view = await screen.findByRole("region", { name: "Scan (from scan)" });
    const again = within(view).getByRole("button", { name: "Scan again" });
    expect(again).toHaveAttribute("aria-keyshortcuts", "R");
    expect(again).toHaveAttribute("title", "Scan again (R)");
    expect(screen.getByRole("grid", { name: "Scan" })).toHaveFocus();
    await user.keyboard("R");
    expect(await screen.findByText("scan: again for scan")).toBeInTheDocument();
    // Typed in the table's filter, it's only a letter.
    await user.keyboard("/R");
    expect(screen.getAllByText("scan: again for scan")).toHaveLength(1);
    await user.keyboard("{Escape}{Escape}");
    await user.keyboard(`${LEADER}:info linux-1-000{Enter}`);
    const details = await screen.findByRole("complementary", { name: "Details of linux-1-000" });
    within(within(details).getByRole("region", { name: "Open ports (from scan)" })).getByRole("grid").focus();
    await user.keyboard("F");
    expect(await screen.findByText("scan: forget ports of linux-1-000")).toBeInTheDocument();
  });

  it("removing the Plugin takes its view (closing it) and its sections away", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    await screen.findByRole("grid", { name: "Scan" });
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:plugins remove scan{Enter}`);
    await screen.findByText("Removed scan");
    await user.keyboard(`${LEADER}:view scan{Enter}`);
    expect(await screen.findByText("There's no view scan: :view lists them")).toBeInTheDocument();
    await user.keyboard(`${LEADER}:info linux-1-000{Enter}`);
    const details = await screen.findByRole("complementary", { name: "Details of linux-1-000" });
    expect(within(details).queryByRole("region", { name: /Open ports/ })).toBeNull();
  });
});
