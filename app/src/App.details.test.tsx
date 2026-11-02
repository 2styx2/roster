// Host details and web services (ticket 18, spec stories 79-80, decision Q71), through the App with
// the fake Backend and a stub terminal: `:info HOST`, the tree's and the Picker's controls, the
// toolbar's toggle, `:open SERVICE`, and both view modes.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "./backend/fake";
import { LONG_NAME_OPEN, worstCaseHosts } from "./backend/worstCase";
import { memoryPlatform, type MemoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

async function ready(scenario: FakeScenario = { hosts: makeHosts(12) }, platform: MemoryPlatform = memoryPlatform()) {
  const user = userEvent.setup();
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} platform={platform} />);
  // 1,284 Hosts (the worst case) take jsdom a while to draw.
  const slow = { timeout: 10_000 };
  await user.type(await screen.findByLabelText(/master password/i, {}, slow), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i }, slow);
  return { user, platform };
}

const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
const panel = (host: string) => screen.queryByRole("complementary", { name: `Details of ${host}` });
const facts = (host: string) =>
  Object.fromEntries(
    within(panel(host) as HTMLElement)
      .getAllByRole("term")
      .map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
  );

describe("Host details", () => {
  it("are closed until asked for; :info HOST shows what roster info shows", async () => {
    const { user } = await ready();
    expect(panel("nas-4-007")).toBeNull();
    await user.keyboard(`${LEADER}:info nas-4-007{Enter}`);
    expect(panel("nas-4-007")).toBeInTheDocument();
    expect(facts("nas-4-007")).toMatchObject({
      type: "nas",
      group: "subnet-4 (10.19.4.0/24)",
      address: "admin@10.19.4.9:22",
      access: "key: ssh nas-4-007",
      "ssh login": "admin, auth key",
      login: "admin, auth bw:nas-4-007 web (default for services)",
      "web UI": "https://10.19.4.9",
    });
    const services = within(panel("nas-4-007") as HTMLElement).getByRole("list", { name: "Services" });
    const rows = within(services).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".svc-name")?.textContent)).toEqual(["web", "admin", "smb"]);
    // Which vault item each Login uses, by its name only.
    expect(rows[1]).toHaveTextContent("nasadmin, auth bw:nas-4-007 admin (own login)");
    expect(rows[2]).toHaveTextContent("445");
  });

  it(":info alone still says what the app runs on", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:info{Enter}`);
    expect(await screen.findByText(/Backend .* · Box /)).toBeInTheDocument();
    expect(document.querySelector(".host-details")).toBeNull();
  });

  it("opens a web service in the default browser from the panel; a service with no URL has no button", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}:info nas-4-007{Enter}`);
    const details = panel("nas-4-007") as HTMLElement;
    await user.click(within(details).getByRole("button", { name: "Open admin in the browser" }));
    expect(platform.urlsOpened()).toEqual(["https://10.19.4.9:5001"]);
    expect(within(details).queryByRole("button", { name: "Open smb in the browser" })).toBeNull();
  });

  it(":open SERVICE opens the details' Host's web service, :open HOST SERVICE any Host's, and :open HOST still opens the Host", async () => {
    const { user, platform } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await user.keyboard(`${LEADER}:info nas-4-007{Enter}`);
    await user.keyboard(`${LEADER}:open web{Enter}`);
    await user.keyboard(`${LEADER}:open printer-3-006 web{Enter}`);
    expect(platform.urlsOpened()).toEqual(["https://10.19.4.9", "http://10.19.3.8"]);
    expect(await screen.findByText("Opened printer-3-006's web in the browser: http://10.19.3.8")).toBeInTheDocument();
    await user.keyboard(`${LEADER}:open linux-1-000{Enter}`);
    expect(await within(output()).findByText(/Connected to linux-1-000/)).toBeInTheDocument();
    await user.keyboard(`${LEADER}:open nas-4-007 smb{Enter}`);
    expect(await screen.findByText("nas-4-007's smb isn't a web service: it has no http or https URL")).toBeInTheDocument();
  });

  it("completes Host names after :info and the details' web services after :open", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:info nas-4{Tab}`);
    expect(screen.getByRole("combobox", { name: "Command" })).toHaveValue("info nas-4-007");
    await user.keyboard("{Enter}");
    await user.keyboard(`${LEADER}:open ad{Tab}`);
    expect(screen.getByRole("combobox", { name: "Command" })).toHaveValue("open admin");
  });

  it("opens from the tree's row control and from the Picker (a row's control, or Ctrl+I)", async () => {
    const { user } = await ready();
    await user.click(screen.getByRole("button", { name: "Show esxi-2-001's details" }));
    expect(panel("esxi-2-001")).toBeInTheDocument();
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("printer");
    await user.keyboard("{Control>}i{/Control}");
    expect(screen.queryByRole("dialog", { name: "Find a Host" })).toBeNull();
    expect(panel("printer-3-006")).toBeInTheDocument();
    expect(panel("esxi-2-001")).toBeNull();
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("nas");
    await user.click(within(screen.getByRole("dialog", { name: "Find a Host" })).getByRole("button", { name: "Show nas-4-007's details" }));
    expect(panel("nas-4-007")).toBeInTheDocument();
  });

  it("the toolbar's control and ␣ i show and hide them for the selected Host, and ␣ Esc closes them", async () => {
    const { user } = await ready();
    const toggle = () => within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: /Host details/ });
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle());
    expect(await screen.findByText(/No Host selected/)).toBeInTheDocument();
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("linux-1-000{Enter}");
    await user.click(toggle());
    expect(panel("linux-1-000")).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    // No services: it says so.
    expect(within(panel("linux-1-000") as HTMLElement).getByText("No services in roster.yml.")).toBeInTheDocument();
    await user.click(toggle());
    expect(panel("linux-1-000")).toBeNull();
    await user.keyboard(`${LEADER}i`);
    expect(panel("linux-1-000")).toBeInTheDocument();
    await user.keyboard(`${LEADER}{Escape}`);
    expect(panel("linux-1-000")).toBeNull();
  });

  it("work in Focus mode too, over the terminal", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}m`);
    expect(document.querySelector(".screen")?.getAttribute("data-view")).toBe("focus");
    await user.keyboard(`${LEADER}:info esxi-2-001{Enter}`);
    expect(panel("esxi-2-001")).toBeInTheDocument();
    await user.keyboard(`${LEADER}:open web{Enter}`);
    expect(platform.urlsOpened()).toEqual(["https://10.19.2.3"]);
  });

  it("never draw a password written into a URL, nor open it (worst case)", { timeout: 30_000 }, async () => {
    const { user, platform } = await ready({ hosts: worstCaseHosts() });
    await user.keyboard(`${LEADER}:info ${LONG_NAME_OPEN}{Enter}`);
    const details = panel(LONG_NAME_OPEN) as HTMLElement;
    expect(details).toBeInTheDocument();
    expect(details.textContent).not.toContain("not-a-real-secret");
    expect(within(details).getAllByRole("listitem")).toHaveLength(40);
    expect(within(details).queryByRole("button", { name: "Open with-a-password-in-the-url in the browser" })).toBeNull();
    await user.keyboard(`${LEADER}:open with-a-password-in-the-url{Enter}`);
    expect(platform.urlsOpened()).toEqual([]);
  });
});
