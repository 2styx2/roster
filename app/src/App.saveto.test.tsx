// Ticket 35 through the App with the fake Backend: the add form's "Save to" control. It lists where
// roster says the vault can save (`vault.targets`, API 10), starts on the default (init.lua's
// `vault.save_to`, else roster.yml's), says where that default is set, is keyboard first, and the
// choice goes to `host.add`. It follows a `:source` while open.
import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_FINGERPRINT, FAKE_HOST_PASSWORD, FAKE_PASSWORD, fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import type { SaveTarget, SaveTo } from "./backend/types";
import { configWith, defaultConfig } from "./config/fixture";
import type { ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const TEAM = { organization: "My Team", collection: "Infra logins" };

const target = (id: string, label: string, saveTo: SaveTo, kind: SaveTarget["kind"] = "collection"): SaveTarget => ({
  id,
  kind,
  label,
  save_to: saveTo,
  ...(kind === "collection" ? { organization: label.split(" / ")[0], collection: label.split(" / ")[1] } : {}),
});
const TARGETS: SaveTarget[] = [
  target("personal", "Personal vault", "personal", "personal"),
  target("collection:c1", "My Team / Infra logins", { organization: "o1", collection: "c1" }),
  target("collection:c2", "Other Org / Misc", { organization: "o2", collection: "c2" }),
];

let version = 0;
const report = (saveTo: SaveTo | null): ConfigReport => ({
  config: configWith({ vault: { ...defaultConfig.vault, saveTo } }),
  error: null,
  path: "/home/me/.config/roster/init.lua",
  version: ++version,
});

async function ready({ setting, saveTo = null, api = 10 }: { setting?: SaveTo; saveTo?: SaveTo | null; api?: number } = {}) {
  const user = userEvent.setup();
  const scenario: FakeScenario = {
    ...(fixtures.add as FakeScenario),
    apiVersion: api,
    saveTo: { targets: TARGETS, ...(setting ? { setting } : {}) },
  };
  const backend = fakeBackend(scenario);
  const config = report(saveTo);
  const platform = memoryPlatform({ config });
  render(<App backend={backend} terminalView={StubTerminal} platform={platform} config={config} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  // The confirmations' whole text shows with every message on (ticket 111).
  await user.keyboard(`${LEADER}:messages all{Enter}`);
  await user.keyboard(`${LEADER}:host add{Enter}`);
  const panel = await screen.findByRole("region", { name: "Add a Host" });
  await within(panel).findByLabelText("Name");
  return { user, backend, platform, panel };
}

const saveTo = (panel: HTMLElement) => within(panel).findByRole("radiogroup", { name: "Save to" });
const checked = (group: HTMLElement) => within(group).getAllByRole("radio").find((r) => (r as HTMLInputElement).checked) ?? null;

async function fillAndAdd(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement) {
  for (const [label, value] of Object.entries({ Name: "nas-01", Address: "10.19.1.50", User: "root" })) {
    await user.type(within(panel).getByLabelText(label), value);
  }
  await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
}

describe("Save to (ticket 35)", () => {
  it("lists exactly where roster says the vault can save, starting on roster.yml's default, and says so", async () => {
    const { panel } = await ready({ setting: TEAM });
    const group = await saveTo(panel);
    expect(within(group).getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual([
      "Personal vault",
      "My Team / Infra logins · default, from roster.yml",
      "Other Org / Misc",
    ]);
    expect(checked(group)).toBe(within(group).getByRole("radio", { name: /My Team \/ Infra logins/ }));
  });

  it("starts on init.lua's choice, which wins over roster.yml's", async () => {
    const { panel } = await ready({ setting: TEAM, saveTo: "personal" });
    const group = await saveTo(panel);
    expect(checked(group)).toBe(within(group).getByRole("radio", { name: /Personal vault/ }));
    expect(group).toHaveTextContent("default, from init.lua");
  });

  it("is keyboard first: Tab reaches it, arrows choose, Enter adds; the choice reaches host.add", async () => {
    const { user, backend, panel } = await ready({ setting: TEAM });
    await fillAndAdd(user, panel);
    const group = await saveTo(panel);
    within(group).getByRole("radio", { name: /My Team/ }).focus();
    await user.keyboard("{ArrowDown}");
    expect(checked(group)).toBe(within(group).getByRole("radio", { name: /Other Org \/ Misc/ }));
    await user.keyboard("{Enter}");
    await user.click(await within(panel).findByRole("button", { name: "Trust it and add" }));
    expect(await screen.findByText(/its password is in the vault as nas-01 ssh, in Other Org \/ Misc\./)).toBeInTheDocument();
    expect(backend.adds().at(-1)).toMatchObject({ name: "nas-01", host_key: FAKE_FINGERPRINT, save_to: { organization: "o2", collection: "c2" } });
  });

  it("asks for a choice when the default names a place that isn't there, and says which setting to fix", async () => {
    const { user, backend, panel } = await ready({ setting: { organization: "Nobody", collection: "x" } });
    const group = await saveTo(panel);
    expect(checked(group)).toBeNull();
    expect(panel).toHaveTextContent("fix providers: bw: save_to: in roster.yml");
    await fillAndAdd(user, panel);
    await user.keyboard("{Enter}");
    expect(within(panel).getByText(/Pick where to save it/)).toBeInTheDocument();
    expect(backend.adds()).toEqual([]);
    await user.click(within(group).getByRole("radio", { name: /Personal vault/ }));
    await user.click(within(panel).getByRole("button", { name: "Test login and add" }));
    await user.click(await within(panel).findByRole("button", { name: "Trust it and add" }));
    expect(await screen.findByText(/its password is in the vault as nas-01 ssh\./)).toBeInTheDocument();
    expect(backend.adds().at(-1)).toMatchObject({ save_to: "personal" });
  });

  it("follows a :source of init.lua while the form is open", async () => {
    const { user, platform, panel } = await ready({ setting: TEAM });
    const group = await saveTo(panel);
    expect(checked(group)).toBe(within(group).getByRole("radio", { name: /My Team/ }));
    await act(() => platform.fileSaved(report({ organization: "Other Org", collection: "Misc" })));
    await user.keyboard(`${LEADER}:`);
    await user.keyboard("source{Enter}");
    await within(panel).findByText(/default, from init\.lua/);
    expect(checked(await saveTo(panel))).toBe(within(panel).getByRole("radio", { name: /Other Org \/ Misc/ }));
  });

  it("isn't there for an existing vault item", async () => {
    const { user, panel } = await ready({ setting: TEAM });
    await saveTo(panel);
    await user.click(within(panel).getByLabelText("An existing vault item"));
    expect(within(panel).queryByRole("radiogroup", { name: "Save to" })).toBeNull();
  });

  it("isn't offered by a roster older than API 10", async () => {
    const { panel } = await ready({ api: 9 });
    expect(within(panel).getByLabelText("Password")).toBeInTheDocument();
    expect(within(panel).queryByRole("radiogroup", { name: "Save to" })).toBeNull();
  });
});
