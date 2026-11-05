// T212 through the App with the fake Backend: a Box with no Inventory offers the three ways to make
// one (serve makes it, ADR 0001), and a plain roster.yml says "saved", never "Pending" or "publish".
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, makeHosts, type FakeBackend } from "./backend/fake";
import { defaultConfig } from "./config/fixture";
import type { ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

function firstRun(name = "inventory-missing") {
  const user = userEvent.setup();
  const backend: FakeBackend = fakeBackend(fixtures[name]!);
  render(<App backend={backend} />);
  return { user, backend };
}

describe("a Box with no Inventory", () => {
  it("offers the three ways, a blank one first, in ~/infra", async () => {
    firstRun();
    expect(await screen.findByRole("heading", { name: "Start your Inventory" })).toBeInTheDocument();
    const how = screen.getByRole("group", { name: "How" });
    const ways = within(how).getAllByRole("radio");
    expect(ways.map((r) => r.closest("label")?.textContent)).toEqual([
      expect.stringMatching(/^A blank one/),
      expect.stringMatching(/^Import a roster\.yml/),
      expect.stringMatching(/^Clone your team's repo/),
    ]);
    expect(ways[0]).toBeChecked();
    expect(ways[0]).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveValue("~/infra");
  });

  it("makes a blank one through serve, then starts on it", async () => {
    const { user, backend } = firstRun();
    const create = vi.spyOn(backend, "createInventory");
    const connect = vi.spyOn(backend, "connect");
    await user.click(await screen.findByRole("button", { name: "Make it" }));
    expect(create).toHaveBeenCalledWith({ how: "blank", folder: "~/infra" });
    expect(await screen.findByText(/Made ~\/infra\/roster\.yml, the Inventory infra now/)).toBeInTheDocument();
    expect(connect).toHaveBeenLastCalledWith({ restart: true });
    expect(screen.queryByRole("heading", { name: "Start your Inventory" })).toBeNull();
  });

  it("imports a roster.yml once a path is given, and says why one isn't taken", async () => {
    const { user, backend } = firstRun();
    const create = vi.spyOn(backend, "createInventory");
    await user.click(await screen.findByRole("radio", { name: /Import a roster\.yml/ }));
    const make = screen.getByRole("button", { name: "Make it" });
    expect(make).toHaveAttribute("aria-disabled", "true");   // no path yet (still focusable, #417 L5)
    await user.type(screen.getByRole("textbox", { name: "Path of the roster.yml" }), "~/Downloads/broken.yml");
    await user.click(make);
    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveTextContent(/doesn't load, so nothing was written/);
    expect(refusal).toHaveTextContent(/fix ~\/Downloads\/broken\.yml first/);
    expect(create).toHaveBeenCalledWith({ how: "file", folder: "~/infra", source: "~/Downloads/broken.yml" });
    expect(screen.getByRole("heading", { name: "Start your Inventory" })).toBeInTheDocument();
  });

  it("clones the team's repo, saying a passphrase can't be answered here", async () => {
    const { user } = firstRun();
    await user.click(await screen.findByRole("radio", { name: /Clone your team's repo/ }));
    const url = screen.getByRole("textbox", { name: "Git URL of the repo" });
    expect(url).toHaveAccessibleDescription(/can.t answer a passphrase/);
    await user.type(url, "git@example.com:team/nope.git{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/git couldn't clone/);
  });

  it("with a roster too old to make one, says what to run in a terminal", async () => {
    const { user } = firstRun("inventory-missing-old");
    await user.click(await screen.findByRole("button", { name: "Make it" }));
    expect(await screen.findByRole("heading", { name: "No Inventory" })).toBeInTheDocument();
    expect(screen.getByText(/needs serve API 28/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("#417's review", () => {
  it("shows a roster.yml that's there but doesn't load as the error it is, never 'make one' (M1)", async () => {
    firstRun("inventory-broken");
    expect(await screen.findByRole("heading", { name: "roster.yml doesn't load" })).toBeInTheDocument();
    expect(screen.getByText(/not valid YAML/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Start your Inventory" })).toBeNull();
  });

  it("keeps focus on a live status while it works, and Cancel stops a clone (L5)", async () => {
    const { user, backend } = firstRun();
    const cancel = vi.spyOn(backend, "cancelCreateInventory");
    await user.click(await screen.findByRole("radio", { name: /Clone your team's repo/ }));
    await user.type(screen.getByRole("textbox", { name: "Git URL of the repo" }), "git@example.com:team/slow.git");
    await user.click(screen.getByRole("button", { name: "Make it" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/Making it/);
    expect(status).toHaveFocus();
    expect(screen.getByRole("form", { name: "Start your Inventory" })).toHaveAttribute("aria-busy", "true");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalled();
    expect(await screen.findByText(/Stopped: nothing was kept/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make it" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("moves focus to a refusal, and a taken name gets a Name field (L4, L5)", async () => {
    const { user, backend } = firstRun("inventory-missing-name-taken");
    const create = vi.spyOn(backend, "createInventory");
    await user.click(await screen.findByRole("button", { name: "Make it" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveFocus();
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.type(name, "infra2");
    await user.click(screen.getByRole("button", { name: "Make it" }));
    expect(create).toHaveBeenLastCalledWith({ how: "blank", folder: "~/infra", name: "infra2" });
    expect(await screen.findByText(/the Inventory infra2 now/)).toBeInTheDocument();
  });
});

describe("a plain roster.yml", () => {
  async function plain() {
    const user = userEvent.setup();
    const backend: FakeBackend = fakeBackend({ ...fixtures["plain-file"]!, hosts: makeHosts(6) });
    const report: ConfigReport = { config: defaultConfig, error: null, path: "/home/me/.config/roster/init.lua", version: 1 };
    render(
      <App backend={backend} terminalView={StubTerminal} registries={builtinRegistries()} platform={memoryPlatform({ config: report })} config={report} />,
    );
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    return { user, backend };
  }

  it("says an edit is saved to roster.yml, and nothing is pending", async () => {
    const { user } = await plain();
    await user.keyboard(`${LEADER}:group new dmz{Enter}`);
    expect(await screen.findByText(/Added group dmz, saved to roster\.yml\./)).toBeInTheDocument();
    expect(screen.queryByText(/Pending change/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Pending changes/ })).toBeNull();
  });

  it("answers :changes and :publish that there's nothing to publish", async () => {
    const { user } = await plain();
    await user.keyboard(`${LEADER}:publish{Enter}`);
    expect(await screen.findByText(/roster\.yml is a plain file .*every edit is saved straight to it/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull();
  });

  it("says a remove is saved straight away, not a Pending change", async () => {
    const { user } = await plain();
    await user.keyboard(`${LEADER}:host remove linux-1-000{Enter}`);
    const ask = await screen.findByRole("alertdialog", { name: "Remove linux-1-000?" });
    expect(ask).toHaveTextContent(/saved straight away/);
    expect(ask).not.toHaveTextContent(/Pending change/);
  });
});
