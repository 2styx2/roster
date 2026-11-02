// `:check` with no Host (ticket 49): this Box's health, shown as the generated help page
// `:help health`, through the App with the fake Backend (its `box.check` fixture has a vault CLI
// that isn't logged in, a Host since the last sync and Pending changes).
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, makeHosts, type FakeScenario } from "./backend/fake";
import type { ConfigReport } from "./config/types";
import { defaultConfig } from "./config/fixture";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";
import type { Registries } from "./registries";
import type { FakePlugin } from "./backend/fakePlugins";

const LEADER = "{Control>} {/Control}";

async function ready(scenario: FakeScenario, opts: { config?: ConfigReport; registries?: Registries } = {}) {
  const user = userEvent.setup();
  const backend = fakeBackend(scenario);
  let boxChecks = 0;
  const checkBox = backend.checkBox.bind(backend);
  backend.checkBox = () => {
    boxChecks++;
    return checkBox();
  };
  render(
    <App
      backend={backend}
      terminalView={StubTerminal}
      registries={opts.registries ?? builtinRegistries()}
      platform={memoryPlatform(opts.config ? { config: opts.config } : {})}
      {...(opts.config ? { config: opts.config } : {})}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, boxChecks: () => boxChecks };
}

async function command(user: ReturnType<typeof userEvent.setup>, line: string) {
  await user.keyboard(`${LEADER}:`);
  await user.keyboard(`${line}{Enter}`);
}

const help = () => screen.getByRole("complementary", { name: "Help" });
const entries = () => [...help().querySelectorAll(".help-def")];

describe(":check with no Host", () => {
  it("shows the Box's health as :help health, each check with its level, fix and topic", async () => {
    const { user, boxChecks } = await ready(fixtures.health as FakeScenario);
    await command(user, "check");
    await waitFor(() => expect(help()).toHaveTextContent(/Checked at .*1 error, 2 warnings/));
    expect(within(help()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("Health");
    const h2 = within(help())
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(h2).toEqual(["The app and roster serve", "roster", "Inventory", "ssh", "Vault", "askpass", "Infra repo", "init.lua", "Terminal font", "Folders (folders)"]);
    const error = entries().find((e) => e.getAttribute("data-tone") === "error") as HTMLElement;
    expect(error).toHaveTextContent("ERROR");
    expect(error).toHaveTextContent(/isn't logged in on this box.*Fix: sign in from the app's lock screen/);
    // Its topic is a link into the error catalog.
    await user.click(within(error).getByRole("link", { name: "E6" }));
    expect(within(help()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("Connection errors");
    expect(help().querySelector(".help-target")).toHaveTextContent("E6");
    expect(boxChecks()).toBe(1);
  });

  it("says all is well on a healthy Box, with the app's own checks", async () => {
    const { user } = await ready({ hosts: makeHosts(12), apiVersion: 16 });
    await command(user, "check");
    await waitFor(() => expect(help()).toHaveTextContent(/no errors or warnings/));
    expect(help()).toHaveTextContent("roster serve answers through Fake: roster 0.1.0, API 16");
    expect(help()).toHaveTextContent("no init.lua: the defaults are in effect");
    expect(help()).toHaveTextContent(/the terminal draws with Iosevka/);
    expect(entries().every((e) => e.getAttribute("data-tone") === "ok")).toBe(true);
  });

  it("with a roster before API 16, runs the app's checks and says roster's need a newer one", async () => {
    const { user, boxChecks } = await ready({ hosts: makeHosts(12), apiVersion: 14 });
    await command(user, "check");
    await waitFor(() => expect(help()).toHaveTextContent(/this roster speaks API 14/));
    expect(boxChecks()).toBe(0);
    expect(help()).toHaveTextContent(/Fix: install a newer roster on this Box/);
  });

  it("an init.lua error is an error of its own, with the file and line", async () => {
    const config: ConfigReport = {
      config: defaultConfig,
      error: { file: "init.lua", line: 7, message: "unexpected symbol near '='" },
      path: "/home/me/.config/roster/init.lua",
      version: 1,
    };
    const { user } = await ready({ hosts: makeHosts(12), apiVersion: 16 }, { config });
    await command(user, "check");
    await waitFor(() => expect(help()).toHaveTextContent(/init\.lua:7: unexpected symbol near '='/));
  });

  it("a Plugin's section shows under its own heading, with where it came from", async () => {
    const registries = builtinRegistries();
    registries.health.register({
      id: "lab",
      source: "lab-tools",
      title: "Lab tools",
      order: 95,
      checks: () => [{ section: "lab", level: "warn", message: "the lab VPN profile is missing" }],
    });
    const { user } = await ready({ hosts: makeHosts(12), apiVersion: 16 }, { registries });
    await command(user, "check");
    await waitFor(() => expect(help()).toHaveTextContent(/the lab VPN profile is missing/));
    expect(within(help()).getByRole("heading", { name: "Lab tools (lab-tools)" })).toBeInTheDocument();
  });

  // Ticket 60: a Plugin's section is a function, called on each :check (like vim.health).
  it("a Plugin's check function runs on :check, and its OK, WARNING and ERROR lines show", async () => {
    let runs = 0;
    const doctor: FakePlugin = {
      manifest: { name: "doctor", version: "1.0.0", description: "Checks the lab", author: null, api: 3, permissions: [] },
      load(roster) {
        roster.health.set("doctor", {
          title: "Doctor",
          check: () => {
            runs++;
            return [
              { level: "ok", message: `checked ${runs} times` },
              { level: "warn", message: "the lab VPN profile is old", fix: "import the new one" },
              { level: "error", message: "the lab CA isn't trusted" },
            ];
          },
        });
      },
    };
    const { user } = await ready({ hosts: makeHosts(12), apiVersion: 16, plugins: { "~/plugins/doctor": doctor } });
    await command(user, "plugins install ~/plugins/doctor");
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    await command(user, "check");
    await waitFor(() => expect(help()).toHaveTextContent(/checked 1 times/));
    expect(within(help()).getByRole("heading", { name: "Doctor (doctor)" })).toBeInTheDocument();
    const lines = entries().filter((e) => /lab|checked/.test(e.textContent ?? ""));
    expect(lines.map((e) => e.getAttribute("data-tone"))).toEqual(["ok", "warn", "error"]);
    expect(lines.map((e) => e.textContent)).toEqual([
      expect.stringMatching(/^OK.*checked 1 times/),
      expect.stringMatching(/^WARNING.*the lab VPN profile is old.*Fix: import the new one/),
      expect.stringMatching(/^ERROR.*the lab CA isn't trusted/),
    ]);
    await command(user, "check");
    await waitFor(() => expect(help()).toHaveTextContent(/checked 2 times/));
  });

  it(":check % checks the Host of the Session on screen, and says when there's none", async () => {
    const { user, boxChecks } = await ready({ hosts: makeHosts(12), apiVersion: 16 });
    await command(user, "check %");
    expect(await screen.findByText(":check % needs a Session on screen")).toBeInTheDocument();
    const host = makeHosts(12).hosts[0]!.name;
    await command(user, `connect ${host}`);
    await command(user, "check %");
    expect(await screen.findByRole("region", { name: `Check ${host}` })).toBeInTheDocument();
    expect(boxChecks()).toBe(0);
  });

  it(":check HOST still checks that one Host", async () => {
    const { user, boxChecks } = await ready({ hosts: makeHosts(12), apiVersion: 16 });
    const host = makeHosts(12).hosts[0]!.name;
    await command(user, `check ${host}`);
    expect(await screen.findByRole("region", { name: `Check ${host}` })).toBeInTheDocument();
    expect(boxChecks()).toBe(0);
  });
});
