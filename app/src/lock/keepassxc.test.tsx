// Ticket 25: the lock screen with KeePassXC (`kp`) as the vault, through the App and the fake Backend.
// It works exactly as with Bitwarden; only the name changes, and "not logged in" means no database here.
import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { FAKE_PASSWORD, fakeBackend, fixtures, type FakeScenario } from "../backend/fake";
import { configWith, defaultConfig } from "../config/fixture";
import type { ConfigReport } from "../config/types";
import { memoryPlatform } from "../platform/memory";
import { StubTerminal } from "../terminal/StubTerminal";

function start(scenario: FakeScenario) {
  const user = userEvent.setup();
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} platform={memoryPlatform()} />);
  return user;
}

describe("the lock screen names KeePassXC", () => {
  it("asks for KeePassXC's master password, says when it's wrong, and unlocks", async () => {
    const user = start(fixtures["keepassxc"] as FakeScenario);
    const dialog = await screen.findByRole("dialog", { name: "Locked" });
    expect(await within(dialog).findByLabelText("KeePassXC master password")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/master password/i), "nope{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Wrong master password");
    await user.type(within(dialog).getByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    expect(await screen.findByRole("main", { name: /workspace/i })).toBeInTheDocument();
  });

  it("says this Box has no database, with roster's fix, instead of asking for a password", async () => {
    start(fixtures["keepassxc-no-database"] as FakeScenario);
    const dialog = await screen.findByRole("dialog", { name: "KeePassXC has no database on this Box" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("roster.kdbx isn't there");
    expect(within(dialog).queryByLabelText(/master password/i)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("says the KeePassXC CLI isn't installed", async () => {
    start({ ...(fixtures["keepassxc"] as FakeScenario), vault: { status: "missing-cli", provider: "kp" } });
    expect(await screen.findByRole("dialog", { name: "The KeePassXC CLI isn't installed" })).toBeInTheDocument();
  });
});

// Ticket 41: the database can be this Box's own, from init.lua. The app sends init.lua's vault
// settings to roster (`vault.configure`, API 10) before it asks where the vault stands, and again on
// every `:source`.
describe("the KeePassXC database from init.lua", () => {
  const MINE = "~/mine.kdbx";
  const scenario = (): FakeScenario => ({
    ...(fixtures["keepassxc"] as FakeScenario),
    apiVersion: 10,
    // roster.yml names no database: only init.lua's makes the vault usable on this Box.
    vault: { status: "locked", provider: "kp", database: MINE },
  });
  const withDatabase = (database: string | null, version = 1): ConfigReport => ({
    config: configWith({ vault: { ...defaultConfig.vault, kp: { database, keyFile: null } } }),
    error: null,
    path: "/home/me/.config/roster/init.lua",
    version,
  });

  it("is sent to roster before the lock screen asks for the master password", async () => {
    const user = userEvent.setup();
    const backend = fakeBackend(scenario());
    const config = withDatabase(MINE);
    render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform({ config })} config={config} />);
    const dialog = await screen.findByRole("dialog", { name: "Locked" });
    expect(await within(dialog).findByLabelText("KeePassXC master password")).toBeInTheDocument();
    expect(backend.vaultSettings()).toEqual({ kp: { database: MINE } });
    await user.type(within(dialog).getByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    expect(await screen.findByRole("main", { name: /workspace/i })).toBeInTheDocument();
  });

  it("says which setting roster left out, and goes on with the rest", async () => {
    const backend = fakeBackend(scenario());
    const configure = backend.configureVault.bind(backend);
    const why = "params.kp.key_file must be an absolute path or start with ~ (a path on the Box roster runs on): 'k'";
    const refused = [{ setting: "kp.key_file", message: why }];
    backend.configureVault = async (s) => ({ ...(await configure(s)), refused });
    const config = withDatabase(MINE);
    render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform({ config })} config={config} />);
    expect(await screen.findByRole("dialog", { name: "Locked" })).toBeInTheDocument();
    expect(await screen.findByText(`roster left out init.lua's vault.kp.key_file: ${why}`)).toBeInTheDocument();
  });

  it("without one, roster.yml's (none here) is used, and the lock screen says so", async () => {
    const backend = fakeBackend(scenario());
    const config = withDatabase(null);
    render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform({ config })} config={config} />);
    expect(await screen.findByRole("dialog", { name: "KeePassXC has no database on this Box" })).toBeInTheDocument();
    expect(backend.vaultSettings()).toEqual({});
  });

  it("a :source that names another database locks the app: its master password was for the old one", async () => {
    const user = userEvent.setup();
    const backend = fakeBackend(scenario());
    const config = withDatabase(MINE);
    const platform = memoryPlatform({ config });
    render(<App backend={backend} terminalView={StubTerminal} platform={platform} config={config} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await act(() => platform.fileSaved(withDatabase("/srv/other.kdbx", 2)));
    await user.keyboard("{Control>} {/Control}:");
    await user.keyboard("source{Enter}");
    expect(await screen.findByRole("dialog", { name: "KeePassXC has no database on this Box" })).toBeInTheDocument();
    expect(backend.vaultSettings()).toEqual({ kp: { database: "/srv/other.kdbx" } });
  });

  it("isn't sent to a roster older than API 10", async () => {
    const backend = fakeBackend({ ...scenario(), apiVersion: 9, vault: { status: "locked", provider: "kp" } });
    const config = withDatabase(MINE);
    render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform({ config })} config={config} />);
    expect(await screen.findByLabelText("KeePassXC master password")).toBeInTheDocument();
    expect(backend.vaultSettings()).toBeNull();
  });
});
