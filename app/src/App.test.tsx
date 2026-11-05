import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, makeHosts } from "./backend/fake";
import { StubTerminal } from "./terminal/StubTerminal";
import { memoryPlatform, type MemoryPlatform } from "./platform/memory";
import type { WindowGeometry } from "./platform/types";

async function ready(scenario = { hosts: makeHosts(12) }, platform = memoryPlatform()) {
  const backend = fakeBackend(scenario);
  const user = userEvent.setup();
  render(<App backend={backend} platform={platform} terminalView={StubTerminal} />);
  await screen.findByText(/12 hosts/i);
  // The app opens locked (ticket 04).
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend };
}

const pickerOpen = () => screen.queryByRole("dialog", { name: /find a host/i }) !== null;

describe("App", () => {
  it("connects to the Backend and says which one, with the Host count", async () => {
    await ready();
    expect(screen.getByText(/Fake/)).toBeInTheDocument();
    expect(pickerOpen()).toBe(false);
  });

  it("opens the Picker with the Leader then f", async () => {
    const { user } = await ready();
    await user.keyboard("f");
    expect(pickerOpen()).toBe(false);
    await user.keyboard("{Control>} {/Control}f");
    expect(pickerOpen()).toBe(true);
    expect(screen.getAllByRole("option")).toHaveLength(12);
  });

  it("ignores an unbound key after the Leader, and Esc leaves App mode", async () => {
    const { user } = await ready();
    await user.keyboard("{Control>} {/Control}x");
    expect(pickerOpen()).toBe(false);
    await user.keyboard("{Escape}f");
    expect(pickerOpen()).toBe(false);
  });

  it("opens the Picker with a click", async () => {
    const { user } = await ready();
    await user.click(within(screen.getByRole("main")).getByRole("button", { name: /find a host/i }));
    expect(pickerOpen()).toBe(true);
  });

  it("opens the Picker from the Sidebar's button too", async () => {
    const { user } = await ready();
    await user.click(within(screen.getByRole("navigation", { name: "Sidebar" })).getByRole("button", { name: /find a host/i }));
    expect(pickerOpen()).toBe(true);
  });

  // IBus or Fcitx on Linux (any IME): the Enter that commits a composed word is the IME's.
  it("doesn't choose a Host on the Enter that ends an IME composition", async () => {
    const { user } = await ready();
    await user.keyboard("{Control>} {/Control}f");
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(pickerOpen()).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(pickerOpen()).toBe(false);
  });

  it("closes the Picker with Esc and gives focus back", async () => {
    const { user } = await ready();
    const before = document.activeElement;
    await user.keyboard("{Control>} {/Control}f");
    await user.keyboard("{Escape}");
    expect(pickerOpen()).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it("remembers the Host you picked and lists it first next time", async () => {
    const { user } = await ready();
    await user.keyboard("{Control>} {/Control}f");
    const target = screen.getAllByRole("option")[5]!.dataset.host!;
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(pickerOpen()).toBe(false);
    const sessions = screen.getByRole("group", { name: "Sessions" });
    expect(within(sessions).getByRole("treeitem", { current: true })).toHaveAccessibleName(new RegExp(`^${target}`));
    await user.keyboard("{Control>} {/Control}f");
    expect(screen.getAllByRole("option")[0]!.dataset.host).toBe(target);
  });

  it("explains a roster that's too old and how to fix it", async () => {
    render(<App backend={fakeBackend(fixtures["roster-too-old"]!)} />);
    expect(await screen.findByRole("heading", { name: /roster is too old/i })).toBeInTheDocument();
    expect(screen.getByText("serve", { selector: "code" }).parentElement).toHaveTextContent(/has no serve command/);
    expect(screen.getByText(/ROSTER_APP_ROSTER/)).toBeInTheDocument();
    expect(screen.getByText(/invalid choice: 'serve'/)).toBeInTheDocument();
  });

  it.each([
    ["roster-missing", /roster wasn't found/i],
    ["inventory-missing", /start your inventory/i],
    ["no-wsl", /no wsl/i],
  ])("explains %s", async (name, heading) => {
    render(<App backend={fakeBackend(fixtures[name]!)} />);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  });

  it("retries with a fresh Backend from the error screen", async () => {
    const backend = fakeBackend({ ...fixtures["roster-too-old"]!, hosts: makeHosts(3), failOnce: true });
    const connect = vi.spyOn(backend, "connect");
    const user = userEvent.setup();
    render(<App backend={backend} />);
    await user.click(await screen.findByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/3 hosts/i)).toBeInTheDocument();
    expect(connect).toHaveBeenLastCalledWith({ restart: true });
  });

  it("shows a failed hosts.list as an error too", async () => {
    const backend = fakeBackend({ hosts: makeHosts(3) });
    vi.spyOn(backend, "listHosts").mockRejectedValue(new Error("the backend exited (code Some(1))"));
    render(<App backend={backend} />);
    expect(await screen.findByText(/the backend exited/)).toBeInTheDocument();
  });

  it("ranks equal matches by recent use, remembered in the State file", async () => {
    const hosts = makeHosts(12);
    const [a, b] = [hosts.hosts[9]!.name, hosts.hosts[5]!.name];
    const platform = memoryPlatform({ state: { version: 1, recentHosts: [a] } });
    const { user } = await ready({ hosts }, platform);
    await user.keyboard("{Control>} {/Control}f");
    expect(screen.getAllByRole("option")[0]!.dataset.host).toBe(a);
    await user.keyboard(b);
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(platform.saved()).toMatchObject({ version: 1, recentHosts: [b, a] }));
  });

  it("starts without recent Hosts when the State file is unreadable", async () => {
    const { user } = await ready({ hosts: makeHosts(12) }, memoryPlatform({ state: { recentHosts: "nope" } }));
    await user.keyboard("{Control>} {/Control}f");
    expect(screen.getAllByRole("option")[0]!.dataset.host).toBe(makeHosts(12).hosts[0]!.name);
  });

  it("keeps the window's size and place in the State file, and shows the title bar on every screen", async () => {
    let settle: ((g: WindowGeometry) => void) | null = null;
    const platform: MemoryPlatform = {
      ...memoryPlatform({ state: { version: 1, recentHosts: ["x"] } }),
      window: {
        minimize() {},
        toggleMaximize() {},
        close() {},
        watchMaximized: () => () => {},
        watchGeometry(cb) {
          settle = cb;
          return () => {};
        },
      },
    };
    render(<App backend={fakeBackend(fixtures["roster-too-old"]!)} platform={platform} />);
    expect(await screen.findByRole("heading", { name: /roster is too old/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    const geometry = { x: 10, y: 20, width: 1200, height: 800, maximized: false };
    act(() => settle?.(geometry));
    await vi.waitFor(() => expect(platform.saved()).toMatchObject({ recentHosts: ["x"], window: geometry }));
  });
});
