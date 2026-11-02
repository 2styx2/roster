// Every panel and view docked, at the width the user picks, or full window (ticket 95, #168,
// decision Q106): `␣ z`, `␣ <` / `␣ >`, the header's button, the draggable edge, the choice kept
// in the State per panel over init.lua's defaults, and Esc docking a panel made full first.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, makeHosts, type FakeScenario } from "./backend/fake";
import type { FakePlugin } from "./backend/fakePlugins";
import { configWith } from "./config/fixture";
import type { Config, ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const PATH = "~/plugins/map";

const report = (config: Config): ConfigReport => ({ config, error: null, path: "/home/me/.config/roster/init.lua", version: 1 });

/** A Plugin with a full view (as Topology's) and nothing else. */
const mapPlugin: FakePlugin = {
  manifest: { name: "map", version: "1.0.0", description: "A map", author: "A. Author", api: 3, permissions: [] },
  load(roster) {
    roster.views.set("map", {
      title: "Map",
      place: "full",
      table: { columns: [{ id: "name", label: "Name" }], rows: [{ id: "linux-1-000", cells: { name: "linux-1-000" }, host: "linux-1-000" }] },
    });
  },
};

async function ready({ config, state, plugin = false }: { config?: Config; state?: Record<string, unknown>; plugin?: boolean } = {}) {
  const user = userEvent.setup();
  const platform = memoryPlatform({ ...(config ? { config: report(config) } : {}), ...(state ? { state } : {}) });
  const backend = fakeBackend({ hosts: makeHosts(12), ...(plugin ? { plugins: { [PATH]: mapPlugin } } : {}) });
  render(<App backend={backend} terminalView={StubTerminal} platform={platform} {...(config ? { config: report(config) } : {})} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  if (plugin) {
    await user.keyboard(`${LEADER}:plugins install ${PATH}{Enter}`);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    await screen.findByText("12 Hosts");
  }
  return { user, platform };
}

const frame = (id: string) => document.querySelector<HTMLElement>(`.panel-frame[data-panel="${id}"]`);
const placeOf = (id: string) => frame(id)?.dataset.place;
const widthOf = (id: string) => frame(id)?.style.getPropertyValue("--pane-w");
const saved = (platform: ReturnType<typeof memoryPlatform>) => (platform.saved() as { panels?: unknown } | undefined)?.panels;
const message = () => document.querySelector(".message-line")?.textContent ?? "";

describe("a panel's place", () => {
  it("␣ z switches the panel used last between docked and full window, and the State keeps it", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}?`);
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:help options{Enter}`);
    await screen.findByRole("complementary", { name: "Help" });
    expect(placeOf("help")).toBe("panel");
    await user.keyboard(`${LEADER}z`);
    expect(placeOf("help")).toBe("full");
    // Quiet by default (ticket 111): only a screen reader hears it.
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toContain("Help: full window");
    expect(saved(platform)).toEqual({ help: { place: "full" } });
    // It stays in App mode: z again (no Leader) docks it.
    await user.keyboard("z");
    expect(placeOf("help")).toBe("panel");
  });

  it("the header's button does the same, pressed while full window; focus stays in the panel", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:info linux-1-000{Enter}`);
    const details = await screen.findByRole("complementary", { name: "Details of linux-1-000" });
    const button = within(details).getByRole("button", { name: "Full window" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(placeOf("details")).toBe("full");
    expect(within(details).getByRole("button", { name: "Full window" })).toHaveAttribute("aria-pressed", "true");
    expect(details).toBeInTheDocument();
  });

  it("Esc first docks a panel made full window, then closes as before", async () => {
    const { user } = await ready({ plugin: true });
    await user.keyboard(`${LEADER}:view map{Enter}`);
    // A Plugin's own `place = "full"` is only where it starts: ␣ < docks it.
    expect(placeOf("view:map")).toBe("full");
    expect(screen.getByRole("grid", { name: "Map" })).toHaveFocus();
    await user.keyboard(`${LEADER}<`);
    expect(placeOf("view:map")).toBe("panel");
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:view map{Enter}`);
    // Remembered: it opens docked now.
    expect(placeOf("view:map")).toBe("panel");
    await user.click(screen.getByRole("button", { name: "Full window" }));
    expect(placeOf("view:map")).toBe("full");
    screen.getByRole("grid", { name: "Map" }).focus();
    await user.keyboard("{Escape}");
    expect(placeOf("view:map")).toBe("panel");
    await user.keyboard("{Escape}");
    expect(frame("view:map")).toBeNull();
  });

  it("Esc in a field of a form made full window closes the form, as it does docked (owner, #176 item 7)", async () => {
    const user = userEvent.setup();
    render(<App backend={fakeBackend(fixtures.edit as FakeScenario)} terminalView={StubTerminal} platform={memoryPlatform()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:edit linux-1-000{Enter}`);
    const form = await screen.findByRole("region", { name: "Edit linux-1-000" });
    const title = await within(form).findByLabelText("Title");
    await user.click(within(form).getByRole("button", { name: "Full window" }));
    expect(placeOf("edit")).toBe("full");
    title.focus();
    await user.keyboard("{Escape}");
    expect(frame("edit")).toBeNull();
  });

  it("a docked panel opened from a full view comes over it, and acts as the panel used last", async () => {
    const { user } = await ready({ plugin: true });
    await user.keyboard(`${LEADER}:view map{Enter}`);
    await user.keyboard(`${LEADER}:info linux-1-000{Enter}`);
    expect(placeOf("view:map")).toBe("full");
    expect(placeOf("details")).toBe("panel");
    await user.keyboard(`${LEADER}z`);
    // Both full: the one used last is on top.
    expect(placeOf("details")).toBe("full");
    expect(frame("details")).toHaveAttribute("data-top");
    expect(frame("view:map")).not.toHaveAttribute("data-top");
  });
});

describe("a panel's width", () => {
  it("␣ > and ␣ < step it by 5% of the window, within limits, and :panel reset forgets it", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}K`);
    await screen.findByRole("complementary", { name: "Key bindings" });
    // jsdom draws nothing: the window is 1024 px and the panel its default 320 (31.3%).
    await user.keyboard(`${LEADER}>`);
    expect(widthOf("keys")).toBe("36.3%");
    await user.keyboard(">>>>>");
    // The terminal keeps 400 px: 624 of 1024 is 60.9%.
    expect(widthOf("keys")).toBe("60.9%");
    await user.keyboard(">");
    expect(message()).toContain("as wide as it goes");
    await user.keyboard("<");
    expect(widthOf("keys")).toBe("55.9%");
    expect(saved(platform)).toEqual({ keys: { width: 55.9 } });
    await user.keyboard(`${LEADER}:panel reset{Enter}`);
    expect(widthOf("keys")).toBe("");
  });

  it("the edge is a separator: its value, arrow keys, Home and End", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}K`);
    const edge = await screen.findByRole("separator", { name: "Resize Key bindings" });
    expect(edge).toHaveAttribute("aria-valuenow", "31");
    expect(edge).toHaveAttribute("aria-valuemin", "27");
    expect(edge).toHaveAttribute("aria-valuemax", "61");
    edge.focus();
    // On the right, ← moves the edge left: wider.
    await user.keyboard("{ArrowLeft}");
    expect(widthOf("keys")).toBe("33.3%");
    expect(edge).toHaveAttribute("aria-valuenow", "33");
    await user.keyboard("{Home}");
    expect(widthOf("keys")).toBe("27.3%");
    await user.keyboard("{End}");
    expect(widthOf("keys")).toBe("60.9%");
  });

  it("a drag draws the panel over the terminal and changes the frame only when it ends", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}K`);
    const edge = await screen.findByRole("separator", { name: "Resize Key bindings" });
    fireEvent.pointerDown(edge, { button: 0, clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 600, pointerId: 1 });
    expect(frame("keys")?.style.getPropertyValue("--pane-live")).toBe("420px");
    expect(widthOf("keys")).toBe("");
    expect(document.documentElement.dataset.resizing).toBe("true");
    fireEvent.pointerUp(edge, { clientX: 600, pointerId: 1 });
    expect(widthOf("keys")).toBe("41%");
    expect(frame("keys")?.style.getPropertyValue("--pane-live")).toBe("");
    expect(document.documentElement.dataset.resizing).toBeUndefined();
  });
});

describe("several docked panels (#176)", () => {
  const body = () => document.querySelector<HTMLElement>(".screen .body");

  it("dock together while the terminal keeps 400 px beside their minimums, and float side by side when it can't", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}K`);
    await user.keyboard(`${LEADER}:info linux-1-000{Enter}`);
    await screen.findByRole("complementary", { name: "Details of linux-1-000" });
    // jsdom's window is 1024 px: two panels at 280 px leave the terminal 464.
    expect(frame("keys")).not.toHaveAttribute("data-float");
    expect(frame("details")).not.toHaveAttribute("data-float");
    expect(body()).toHaveAttribute("data-docked");
    await user.keyboard(`${LEADER}:help options{Enter}`);
    await screen.findByRole("complementary", { name: "Help" });
    // A third doesn't fit: all three float over the terminal, side by side, none on another.
    for (const id of ["keys", "details", "help"]) expect(frame(id)).toHaveAttribute("data-float");
    expect(body()).not.toHaveAttribute("data-docked");
    const at = ["keys", "details", "help"].map((id) => frame(id)?.style.getPropertyValue("--pane-at"));
    expect(new Set(at).size).toBe(3);
    expect(at).toContain("0px");
    await user.keyboard(`{Escape}`);
    await user.keyboard(`${LEADER}:help options{Enter}`);
    await user.keyboard(`${LEADER}z`);
    // Full window takes no part: the other two dock again.
    expect(placeOf("help")).toBe("full");
    expect(frame("keys")).not.toHaveAttribute("data-float");
  });

  it("the layering rule needs no :has(): the body says when a panel is full window", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}K`);
    expect(body()).not.toHaveAttribute("data-full");
    await user.keyboard(`${LEADER}z`);
    expect(body()).toHaveAttribute("data-full");
  });
});

describe("init.lua's defaults", () => {
  it("views.ID and panel.width set where a panel starts; the user's choice wins over them", async () => {
    const config = configWith({ panel: { width: 35 }, views: { help: { place: "full", width: null }, map: { place: "panel", width: 50 } } });
    const { user } = await ready({ config, plugin: true });
    await user.keyboard(`${LEADER}K`);
    expect(widthOf("keys")).toBe("35%");
    await user.keyboard(`{Escape}${LEADER}:view map{Enter}`);
    expect(placeOf("view:map")).toBe("panel");
    expect(widthOf("view:map")).toBe("50%");
    await user.keyboard(`{Escape}${LEADER}:help{Enter}`);
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:help options{Enter}`);
    expect(placeOf("help")).toBe("full");
    await user.keyboard(`${LEADER}z`);
    expect(placeOf("help")).toBe("panel");
  });

  it("the State's choice is read at start", async () => {
    const { user } = await ready({ state: { version: 1, panels: { keys: { place: "full" } } } });
    await user.keyboard(`${LEADER}K`);
    expect(placeOf("keys")).toBe("full");
  });
});
