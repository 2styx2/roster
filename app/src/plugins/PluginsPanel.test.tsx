// `:plugins`' rows: each network site a Plugin was granted says how many requests went there
// since the app started (decision Q116): counts and a time, never what was sent.
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { dataLine, PluginsPanel, REFRESH_MS } from "./PluginsPanel";
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
