// The interface review's fixes (ticket 29, docs/app/design/interface-review.md), through the App with
// the fake Backend and a stub terminal: copy, accessible names and keys, item by item.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_EMAIL, FAKE_PASSWORD, fakeBackend, fixtures, makeHosts, type FakeScenario } from "./backend/fake";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

/** The App over a fixture, unlocked when it has a lock screen. */
async function ready(scenario: FakeScenario = { hosts: makeHosts(12) }, platform = memoryPlatform()) {
  const user = userEvent.setup();
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

/** The App over a fixture that stops before the workspace (a start error, a lock problem). */
function start(scenario: FakeScenario, platform = memoryPlatform()) {
  const user = userEvent.setup();
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} platform={platform} />);
  return user;
}

describe("S1: errors show commands as code, not Markdown", () => {
  it("a Session error's message and fix have no backticks", async () => {
    const user = await ready(fixtures["not-set-up"]);
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("linux-1-000{Enter}");
    const panel = await screen.findByRole("alert");
    // Details keeps roster's raw text; the message and the fix are what people read.
    const read = [...panel.querySelectorAll(".problem-message, .problem-facts dd")].map((e) => e.textContent).join(" ");
    expect(read).toContain("roster sync");
    expect(read).not.toContain("`");
    expect(within(panel).getAllByText("roster sync", { selector: "code" }).length).toBeGreaterThan(0);
  });
});

describe("S9: the start-error screen is a clean error", () => {
  it("has the message, Where, the Fix with Copy, Retry, and the raw output closed under Details", async () => {
    const platform = memoryPlatform();
    const user = start(fixtures["roster-too-old"] as FakeScenario, platform);
    const screenEl = await screen.findByRole("region", { name: "roster is too old" });
    expect(screenEl.textContent).not.toContain("`");
    expect(within(screenEl).getByText("serve", { selector: "code" })).toBeInTheDocument();
    expect(within(screenEl).getByText("Where")).toBeInTheDocument();
    expect(within(screenEl).getByText("Fix")).toBeInTheDocument();
    const details = within(screenEl).getByText("Details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(within(screenEl).getByRole("button", { name: "Retry" })).toHaveFocus();
    const copy = within(screenEl).getAllByRole("button", { name: "Copy" })[0] as HTMLElement;
    await user.click(copy);
    expect(await platform.clipboard.readText()).toBe("uv tool install --force --reinstall .");
  });
});

describe("S2: a key closes the side panels", () => {
  it("Esc in App mode closes the :check panel, then the Key bindings panel", async () => {
    const user = await ready({ hosts: makeHosts(12), apiVersion: 3 });
    await user.keyboard(`${LEADER}:check linux-1-000{Enter}`);
    expect(await screen.findByRole("region", { name: "Check linux-1-000" })).toBeInTheDocument();
    await user.keyboard(`${LEADER}{Escape}`);
    expect(screen.queryByRole("region", { name: "Check linux-1-000" })).toBeNull();
  });

  it(":hidepanel closes the topmost panel, so init.lua can bind it", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}K`);
    expect(screen.getByRole("complementary", { name: "Key bindings" })).toBeInTheDocument();
    await user.keyboard(`${LEADER}:hidepanel{Enter}`);
    expect(screen.queryByRole("complementary", { name: "Key bindings" })).toBeNull();
  });
});

describe("S3: the Leader keycap reads as Leader", () => {
  it('names a key hint "Leader f", never with the ␣ glyph', async () => {
    await ready();
    const find = within(screen.getByRole("navigation", { name: "Sidebar" })).getByRole("button", { name: /^Find a Host/ });
    expect(find).toHaveAccessibleName("Find a Host, Leader f");
  });
});

describe("S4: :check announces each step's result", () => {
  it("says passed, failed or skipped in words", async () => {
    const user = await ready({ hosts: makeHosts(12), apiVersion: 3 });
    await user.keyboard(`${LEADER}:check linux-1-000{Enter}`);
    const region = await screen.findByRole("region", { name: "Check linux-1-000" });
    const steps = await within(region).findAllByRole("listitem");
    expect(steps[0]).toHaveTextContent(/passed/);
    expect(steps[0]?.querySelector(".check-mark")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("S5: sign-in fields say when they were refused", () => {
  it("marks the master password invalid, described by the error, only while there is one", async () => {
    const user = start(fixtures["sign-in"] as FakeScenario);
    const dialog = await screen.findByRole("dialog", { name: /sign in/i });
    await user.keyboard("{Enter}");
    await user.type(within(dialog).getByLabelText(/email/i), `${FAKE_EMAIL}{Enter}`);
    const pw = within(dialog).getByLabelText(/master password/i);
    expect(pw).not.toHaveAttribute("aria-invalid");
    expect(pw).not.toHaveAttribute("aria-describedby");
    await user.type(pw, "wrong{Enter}");
    await within(dialog).findByRole("alert");
    expect(pw).toHaveAttribute("aria-invalid", "true");
    expect(pw).toHaveAccessibleDescription(/didn't accept that email and master password/i);
  });
});

describe("S7: an empty Inventory says what to do", () => {
  const empty: FakeScenario = { hosts: { hosts: [], groups: {} }, vault: { status: "unsupported" } };

  it("the Picker, the Sidebar and the workspace point at roster.yml", async () => {
    const user = start(empty);
    const main = await screen.findByRole("main", { name: /workspace/i });
    expect(main).toHaveTextContent(/No Hosts in the Inventory yet/);
    expect(main).toHaveTextContent("~/infra/roster.yml");
    expect(within(main).queryByRole("button", { name: /find a host/i })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Inventory" })).getByText(/No Hosts yet\. Add them in roster\.yml\./)).toBeInTheDocument();
    await user.keyboard(`${LEADER}f`);
    const picker = screen.getByRole("dialog", { name: "Find a Host" });
    expect(picker).toHaveTextContent("The Inventory has no Hosts yet. Add them to roster.yml and they show up here.");
    expect(picker).not.toHaveTextContent("“”");
  });

  it("keeps the no-match line for a real query", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("zzzz");
    expect(screen.getByRole("dialog", { name: "Find a Host" })).toHaveTextContent("No Hosts match “zzzz”.");
  });
});

describe("S8: command line completions say what they do", () => {
  it("lists each command with its label and key, list motions last", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:c`);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.querySelector(".cmd-id")?.textContent)).toEqual(["changes", "check", "close", "cmdline", "connect ", "cancel", "config", "choose"]);
    expect(options[1]).toHaveTextContent(/Check this Box's health/);
    expect(options[3]).toHaveTextContent(/Command line.*Leader\s*:/);
  });
});

describe("S10: lock and sign-in copy", () => {
  it("says the CLI isn't signed in, rather than Locked, with the command to copy", async () => {
    const platform = memoryPlatform();
    const user = start(fixtures["not-logged-in"] as FakeScenario, platform);
    const dialog = await screen.findByRole("dialog", { name: "Bitwarden isn't signed in on this Box" });
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(platform.clipboardText()).toBe("bw login");
  });

  it("says the CLI isn't installed", async () => {
    start(fixtures["missing-cli"] as FakeScenario);
    expect(await screen.findByRole("dialog", { name: "The Bitwarden CLI isn't installed" })).toBeInTheDocument();
  });

  it("draws the step keys as keycaps, and drops Where and a Fix that repeats the message", async () => {
    const user = start(fixtures["sign-in-rate-limited"] as FakeScenario);
    const dialog = await screen.findByRole("dialog", { name: /sign in/i });
    expect(dialog.querySelector(".signin-keys .keycap")).not.toBeNull();
    await user.keyboard("{Enter}");
    await user.type(within(dialog).getByLabelText(/email/i), `${FAKE_EMAIL}{Enter}`);
    await user.type(within(dialog).getByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/too many sign-in attempts/i);
    expect(within(alert).queryByText("Where")).toBeNull();
    expect(within(alert).queryByText("Fix")).toBeNull();
  });
});

describe("S12: the :theme finder shows the current Theme", () => {
  it("marks it current and opens on it", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:theme{Enter}`);
    const selected = screen.getByRole("option", { selected: true });
    expect(selected).toHaveTextContent(/Roster (dark|light).*current/);
    expect(screen.getAllByRole("option").filter((o) => /current/.test(o.textContent ?? ""))).toHaveLength(1);
  });
});

describe("N1: the Key bindings panel without the noise", () => {
  it("shows a source only when it isn't builtin, and one row for Go to Session 1–9", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}K`);
    const panel = screen.getByRole("complementary", { name: "Key bindings" });
    expect(within(panel).queryAllByText("builtin")).toHaveLength(0);
    expect(within(panel).getAllByText(/^Go to Session/)).toHaveLength(1);
    expect(within(panel).getByText("Go to Session 1–9")).toBeInTheDocument();
    await user.keyboard("builtin");
    expect(within(panel).getByText("Next Session")).toBeInTheDocument();
  });
});

describe("N2: domain terms are capitalised as in the glossary", () => {
  it("writes Host and Box with capitals in the app's own strings", async () => {
    const user = await ready();
    expect(screen.getByText("12 Hosts")).toBeInTheDocument();
    await user.keyboard(`${LEADER}f`);
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "Find a Host: name, address, type, product, group…");
    expect(screen.getByRole("dialog", { name: "Find a Host" })).toHaveTextContent("12 Hosts");
  });
});

describe("N7: the Sessions finder explains its marks", () => {
  it("names the current and previous Session, and has a legend", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:connect linux-1-000{Enter}`);
    await user.keyboard(`${LEADER}:connect esxi-2-001{Enter}`);
    await user.keyboard(`${LEADER}b`);
    const dialog = screen.getByRole("dialog", { name: /session/i });
    expect(within(dialog).getByRole("option", { name: /esxi-2-001.*current/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: /linux-1-000.*previous/ })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("* current · - previous");
  });
});

describe("M6: the status bar's path, whole, from the keyboard", () => {
  it(":info says the Backend, the Box and the Inventory's path", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:info{Enter}`);
    expect(screen.getByRole("status")).toHaveTextContent(/~\/infra\/roster\.yml/);
  });

  it(":info says which roster command runs, since it's what gets the master password (review 2)", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:info{Enter}`);
    expect(screen.getByRole("status")).toHaveTextContent(/Command roster serve/);
  });
});
