// `:plugins`' rows: each network site a Plugin was granted says how many requests went there
// since the app started (decision Q116): counts and a time, never what was sent.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PackageStatus } from "../backend/types";
import { dataLine, PackagesPanel, PluginsPanel, REFRESH_MS, UPGRADE_TOPIC } from "./PluginsPanel";
import type { PluginStatus, Snapshot } from "./manager";

const NOW = Date.now();

const status = (over: Partial<PluginStatus> = {}): PluginStatus => ({
  name: "webhook",
  path: "~/plugins/webhook",
  builtin: false,
  manifest: {
    name: "webhook",
    version: "1.0.0",
    description: "Posts alerts",
    author: null,
    api: 2,
    permissions: [
      { name: "network:hooks.example.com", summary: "Send and fetch over the network: hooks.example.com", risk: "Can send data" },
      { name: "network:private:nas.lan", summary: "Send and fetch over the network: nas.lan on your private network", risk: "Can send data" },
      { name: "network:api.example.com", summary: "Send and fetch over the network: api.example.com", risk: "Can send data" },
    ],
  },
  granted: ["network:hooks.example.com", "network:private:nas.lan"],
  problem: null,
  waiting: false,
  uses: [],
  requests: [{ site: "hooks.example.com", requests: 1234, failed: 2, last: NOW - 120_000 }],
  data: null,
  ...over,
});

const snap = (plugins: PluginStatus[]): Snapshot => ({
  plugins,
  packages: [],
  prompts: [],
  notices: [],
  float: null,
  confirm: null,
  progress: [],
  declined: [],
  settled: true,
});

const row = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

describe("PluginsPanel's request counts", () => {
  it("says under each granted site how many requests went there, how many failed, and when", () => {
    render(<PluginsPanel snapshot={snap([status()])} onGrant={() => undefined} onClose={() => undefined} />);
    expect(within(row("network:hooks.example.com")).getByText("1,234 requests, 2 with no answer, the last 2m ago")).toBeInTheDocument();
    expect(within(row("network:private:nas.lan")).getByText("No requests since roster started")).toBeInTheDocument();
    // Not granted: nothing to count.
    expect(within(row("network:api.example.com")).queryByText(/requests/)).toBeNull();
  });

  it("says one request in the singular, and nothing about failures when there were none", () => {
    render(
      <PluginsPanel
        snapshot={snap([status({ requests: [{ site: "hooks.example.com", requests: 1, failed: 0, last: NOW - 600_000 }] })])}
        onGrant={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(within(row("network:hooks.example.com")).getByText("1 request, the last 10m ago")).toBeInTheDocument();
  });
});

describe("PluginsPanel's refresh", () => {
  it("asks for the counts when it opens and again every few seconds while it's open, and stops when it closes", () => {
    vi.useFakeTimers();
    try {
      const onRefresh = vi.fn();
      const { unmount } = render(<PluginsPanel snapshot={snap([status()])} onGrant={() => undefined} onClose={() => undefined} onRefresh={onRefresh} />);
      expect(onRefresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(REFRESH_MS);
      expect(onRefresh).toHaveBeenCalledTimes(2);
      unmount();
      vi.advanceTimersByTime(REFRESH_MS * 3);
      expect(onRefresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PluginsPanel's data-folder line (ticket 98)", () => {
  it("says how full the data folder is against both caps", () => {
    render(<PluginsPanel snapshot={snap([status({ data: { state: "used", files: 34, bytes: 2_202_010 } })])} onGrant={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText("Data: 2.1 MB in 34 files (of 10 MB, 1,000 files)")).toBeInTheDocument();
  });

  it("says no data yet for a Plugin that has none, and nothing before the core has answered", () => {
    const { rerender } = render(<PluginsPanel snapshot={snap([status()])} onGrant={() => undefined} onClose={() => undefined} />);
    expect(screen.queryByText(/^Data:/)).toBeNull();
    rerender(<PluginsPanel snapshot={snap([status({ data: { state: "none" } })])} onGrant={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText("Data: none yet")).toBeInTheDocument();
  });

  it("puts sizes in bytes, KB or MB, one file in the singular, and says why when it can't count", () => {
    const line = (files: number, bytes: number) => dataLine({ state: "used", files, bytes });
    expect(line(0, 0)).toBe("Data: none yet");
    expect(line(1, 5)).toBe("Data: 5 bytes in 1 file (of 10 MB, 1,000 files)");
    expect(line(3, 1)).toBe("Data: 1 byte in 3 files (of 10 MB, 1,000 files)");
    expect(line(12, 12_800)).toBe("Data: 13 KB in 12 files (of 10 MB, 1,000 files)");
    // Just under a megabyte reads as one, not "1,024 KB".
    expect(line(2, 1_048_100)).toBe("Data: 1.0 MB in 2 files (of 10 MB, 1,000 files)");
    expect(line(1000, 10 * 1024 * 1024)).toBe("Data: 10.0 MB in 1,000 files (of 10 MB, 1,000 files)");
    expect(dataLine({ state: "problem", message: "the Plugin's data folder is a link (x): roster won't follow it" })).toBe(
      "Data: can't count it: the Plugin's data folder is a link (x): roster won't follow it",
    );
  });

  it("asks for the sizes once when it opens, not on every refresh", () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      render(<PluginsPanel snapshot={snap([status()])} onGrant={() => undefined} onClose={() => undefined} onRefresh={() => undefined} onOpen={onOpen} />);
      vi.advanceTimersByTime(REFRESH_MS * 3);
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

const pkg = (over: Partial<PackageStatus> = {}): PackageStatus => ({
  name: "recent-alerts",
  source: "team/recent-alerts",
  url: "https://git.example.com/team/recent-alerts.git",
  dir: null,
  wants: "default branch",
  commit: null,
  locked: null,
  pinned: false,
  config: {},
  note: null,
  error: null,
  ...over,
});

const packagesSnap = (packages: PackageStatus[], over: Partial<Snapshot> = {}): Snapshot => ({ ...snap([]), packages, ...over });

/** The buttons in a row, by their visible text. */
const buttons = (li: HTMLElement) => within(li).queryAllByRole("button").map((b) => b.textContent);

describe("PackagesPanel's Fix buttons (errors.md rows 116-121, issue #213)", () => {
  it("a Package that can't be fetched has Try again, which fetches it again through :packages install", () => {
    const onRun = vi.fn();
    render(<PackagesPanel snapshot={packagesSnap([pkg({ error: "can't fetch https://git.example.com/team/recent-alerts.git: fatal: could not read Username" })])} onClose={() => undefined} onRun={onRun} />);
    const li = screen.getByRole("listitem", { name: "recent-alerts, can't fetch" });
    expect(buttons(li)).toEqual(["Try again"]);
    const button = within(li).getByRole("button", { name: "Try again (recent-alerts)" });
    expect(button).toHaveAttribute("title", ":packages install recent-alerts");
    fireEvent.click(button);
    expect(onRun).toHaveBeenCalledWith("packages install recent-alerts");
  });

  it("a cancelled install has Install…, which asks again (the install prompt), never installs by itself", () => {
    const onRun = vi.fn();
    render(<PackagesPanel snapshot={packagesSnap([pkg({ commit: "1".repeat(40) })], { declined: ["recent-alerts"] })} onClose={() => undefined} onRun={onRun} />);
    const li = screen.getByRole("listitem", { name: "recent-alerts, cancelled" });
    fireEvent.click(within(li).getByRole("button", { name: "Install… (recent-alerts)" }));
    expect(onRun).toHaveBeenCalledWith("packages install recent-alerts");
  });

  it("a stopped Package's Plugin has Reload and Check for an update", () => {
    const onRun = vi.fn();
    const plugin = status({ name: "alerts", path: "package:recent-alerts", problem: "init.lua:12: attempt to index a nil value" });
    render(<PackagesPanel snapshot={packagesSnap([pkg({ commit: "1".repeat(40), locked: "1".repeat(40), pinned: true })], { plugins: [plugin] })} onClose={() => undefined} onRun={onRun} />);
    const li = screen.getByRole("listitem", { name: "recent-alerts, stopped" });
    expect(buttons(li)).toEqual(["Reload", "Check for an update"]);
    fireEvent.click(within(li).getByRole("button", { name: "Reload (alerts)" }));
    expect(onRun).toHaveBeenLastCalledWith("plugins reload alerts");
    fireEvent.click(within(li).getByRole("button", { name: "Check for an update (recent-alerts)" }));
    expect(onRun).toHaveBeenLastCalledWith("packages update recent-alerts");
  });

  it("a running Package has no buttons, and none without onRun", () => {
    const plugin = status({ name: "alerts", path: "package:recent-alerts" });
    const { unmount } = render(<PackagesPanel snapshot={packagesSnap([pkg({ commit: "1".repeat(40), locked: "1".repeat(40), pinned: true })], { plugins: [plugin] })} onClose={() => undefined} onRun={() => undefined} />);
    expect(buttons(screen.getByRole("listitem", { name: "recent-alerts, running" }))).toEqual([]);
    unmount();
    render(<PackagesPanel snapshot={packagesSnap([pkg({ error: "can't fetch it" })])} onClose={() => undefined} />);
    expect(buttons(screen.getByRole("listitem", { name: "recent-alerts, can't fetch" }))).toEqual([]);
  });

  it("gives the keys back to the panel when the button pressed goes away", () => {
    const error = packagesSnap([pkg({ error: "can't fetch it" })]);
    const { rerender } = render(<PackagesPanel snapshot={error} onClose={() => undefined} onRun={() => undefined} />);
    const button = screen.getByRole("button", { name: "Try again (recent-alerts)" });
    button.focus();
    fireEvent.click(button);
    const fetched = pkg({ commit: "1".repeat(40), locked: "1".repeat(40), pinned: true });
    rerender(<PackagesPanel snapshot={packagesSnap([fetched], { plugins: [status({ name: "alerts", path: "package:recent-alerts" })] })} onClose={() => undefined} onRun={() => undefined} />);
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Packages" }));
  });
});

describe("PluginsPanel's Fix buttons (errors.md rows 120-121)", () => {
  it("a stopped Plugin has Reload", () => {
    const onRun = vi.fn();
    render(<PluginsPanel snapshot={snap([status({ problem: "it failed 3 times" })])} onGrant={() => undefined} onClose={() => undefined} onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload (webhook)" }));
    expect(onRun).toHaveBeenCalledWith("plugins reload webhook");
  });

  it("a Package init.lua no longer names has no Reload: :packages clean is the way", () => {
    const gone = status({ name: "alerts", path: "package:recent-alerts", problem: "init.lua no longer names it: :packages clean removes it" });
    render(<PluginsPanel snapshot={snap([gone])} onGrant={() => undefined} onClose={() => undefined} onRun={() => undefined} />);
    expect(screen.queryByRole("button", { name: /^Reload/ })).toBeNull();
  });

  it("a running Plugin has no Reload", () => {
    render(<PluginsPanel snapshot={snap([status()])} onGrant={() => undefined} onClose={() => undefined} onRun={() => undefined} />);
    expect(screen.queryByRole("button", { name: /^Reload/ })).toBeNull();
  });
});

describe("PluginsPanel's hint for Plugins written before api 4 (issue #228)", () => {
  it("says their info notices are quiet now, with the authors' note one click away", () => {
    const onRun = vi.fn();
    render(<PluginsPanel snapshot={snap([status()])} onGrant={() => undefined} onClose={() => undefined} onRun={onRun} />);
    const li = screen.getByRole("listitem", { name: "webhook, running" });
    expect(li).toHaveTextContent("Written for api 2: its info notices are quiet now unless it marks them quiet = false, and :messages keeps them.");
    fireEvent.click(within(li).getByRole("button", { name: "What changed (webhook)" }));
    expect(onRun).toHaveBeenCalledWith(`help ${UPGRADE_TOPIC}`);
  });

  it("says nothing for api 4 and later, or a built-in Plugin", () => {
    const current = status({ name: "fresh", manifest: { name: "fresh", version: "1.0.0", description: "", author: null, api: 4, permissions: [] } });
    const builtin = status({ name: "hosts", path: "builtin:hosts", builtin: true, manifest: { name: "hosts", version: "1.0.0", description: "", author: null, api: 1, permissions: [] } });
    render(<PluginsPanel snapshot={snap([current, builtin])} onGrant={() => undefined} onClose={() => undefined} onRun={() => undefined} />);
    expect(screen.queryByText(/Written for api/)).toBeNull();
  });
});
