// Round 20 (H9): what goes wrong with a Sidebar row is said by the row. An unreviewed Host's refusal
// shows under its row (a click, or Enter in App mode), not at the foot of the pane; an ended or
// refused Session's row says so in one word and keeps a Reconnect button.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const LEADER = "{Control>} {/Control}";

async function ready() {
  const user = userEvent.setup();
  render(<App backend={fakeBackend({ hosts })} terminalView={StubTerminal} />);
  await screen.findByText(/12 hosts/i);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const inventory = () => screen.getByRole("group", { name: "Inventory" });
const sessions = () => screen.getByRole("group", { name: "Sessions" });
const messageLine = () => document.querySelector(".message-line") as HTMLElement;
const slip = () => document.querySelector<HTMLElement>(".sb-slip");
const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });

describe("a row's own trouble, said by the row (round 20)", () => {
  it("says an unreviewed Host's refusal under its row, with the next step, and not on the message line", async () => {
    const user = await ready();
    await user.click(within(inventory()).getByRole("treeitem", { name: /^switch-4-003/ }));
    expect(slip()).toHaveAttribute("data-row-slip", "inventory:switch-4-003");
    expect(slip()).toHaveTextContent(/switch-4-003 isn.t reviewed yet, so it can.t be opened\. (:review switch-4-003 marks it reviewed|Set reviewed: true for it in roster\.yml)/);
    expect(messageLine()).not.toHaveTextContent(/isn't reviewed/);
    // The next key ends it; :messages still has it.
    await user.keyboard("{Escape}");
    expect(slip()).toBeNull();
  });

  it("does the same for Enter in App mode", async () => {
    const user = await ready();
    await user.keyboard(LEADER);
    for (let i = 0; i < 40 && !document.querySelector('.sidebar .cursor[data-row="inventory:switch-4-003"]'); i++)
      await user.keyboard("j");
    await user.keyboard("{Enter}");
    expect(slip()).toHaveAttribute("data-row-slip", "inventory:switch-4-003");
    expect(slip()).toHaveTextContent(/switch-4-003 isn't reviewed yet/);
    expect(messageLine()).not.toHaveTextContent(/isn't reviewed/);
  });

  it("leaves what a typed command says on the message line", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:connect switch-4-003{Enter}`);
    expect(messageLine()).toHaveTextContent(/switch-4-003 isn't reviewed yet/);
    expect(slip()).toBeNull();
  });

  it("gives an ended Session's row one word and a Reconnect button that reconnects it", async () => {
    const user = await ready();
    await user.click(within(inventory()).getByRole("treeitem", { name: /^linux-1-000/ }));
    await within(output()).findByText(/Connected to linux-1-000/);
    await user.keyboard("exit{Enter}");
    const row = await within(sessions()).findByRole("treeitem", { name: "linux-1-000, ended" });
    expect(row).toHaveTextContent(/ended/);
    expect(row.closest("li")?.querySelector(".sb-text")?.getAttribute("title")).toMatch(/Ended \(exit code 0\)\.\n↻ reconnects it/);
    await user.click(screen.getByRole("button", { name: "Reconnect linux-1-000" }));
    expect(await within(sessions()).findByRole("treeitem", { name: /^linux-1-000, (key|password) login/ })).toBeInTheDocument();
  });
});
