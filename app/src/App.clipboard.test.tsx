// Copy, cut, paste, select all and undo in every text field (iteration 3 feedback): the keymap and
// the vim layer must leave Ctrl+C/V/X/A/Z to the field, which the WebView then handles as usual.
// A key the app takes is one it preventDefault()s, so that's what these look at.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const EDITING = ["c", "v", "x", "a", "z"];

/** The editing chords that something in the app took from the focused field. */
function taken(field: Element = document.activeElement as Element): string[] {
  const shifted = EDITING.map((k) => ({ key: k.toUpperCase(), shiftKey: true, name: `Ctrl+Shift+${k}` }));
  const plain = EDITING.map((k) => ({ key: k, shiftKey: false, name: `Ctrl+${k}` }));
  // Ctrl+Shift+Z is redo; Ctrl+Insert / Shift+Insert copy and paste in a field too.
  const keys = [...plain, shifted[4]!, { key: "Insert", shiftKey: false, name: "Ctrl+Insert" }];
  const out = keys.filter(({ key, shiftKey }) => !fireEvent.keyDown(field, { key, ctrlKey: true, shiftKey })).map((k) => k.name);
  if (!fireEvent.keyDown(field, { key: "Insert", shiftKey: true })) out.push("Shift+Insert");
  return out;
}

async function ready(scenario: FakeScenario = fixtures.add as FakeScenario) {
  const user = userEvent.setup();
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} platform={memoryPlatform()} />);
  const password = await screen.findByLabelText(/master password/i);
  await user.type(password, `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user };
}

describe("Editing keys in text fields", () => {
  it("reach the lock screen's password field", async () => {
    render(<App backend={fakeBackend(fixtures.add as FakeScenario)} terminalView={StubTerminal} platform={memoryPlatform()} />);
    expect(taken(await screen.findByLabelText(/master password/i))).toEqual([]);
  });

  it("reach the command line, the Picker, a finder and the key bindings filter", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:`);
    expect(document.activeElement).toBeInstanceOf(HTMLInputElement);
    expect(taken()).toEqual([]);
    await user.keyboard("{Escape}{Escape}");

    await user.keyboard(`${LEADER}f`);
    expect(document.activeElement).toBeInstanceOf(HTMLInputElement);
    expect(taken()).toEqual([]);
    await user.keyboard("{Escape}");

    await user.keyboard(`${LEADER}b`);
    expect(document.activeElement).toBeInstanceOf(HTMLInputElement);
    expect(taken()).toEqual([]);
    await user.keyboard("{Escape}");

    await user.keyboard(`${LEADER}K`);
    const filter = await screen.findByRole("searchbox");
    await user.click(filter);
    expect(taken(filter)).toEqual([]);
  });

  it("reach the add and edit forms", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:host add{Enter}`);
    const add = await screen.findByRole("region", { name: "Add a Host" });
    const name = await within(add).findByLabelText("Name");
    await user.click(name);
    expect(taken(name)).toEqual([]);
  });

  it("reach the edit form", async () => {
    const { user } = await ready(fixtures.edit as FakeScenario);
    await user.keyboard(`${LEADER}:edit linux-1-000{Enter}`);
    const panel = await screen.findByRole("region", { name: "Edit linux-1-000" });
    await within(panel).findByText("Up to date with origin/main.");
    const title = within(panel).getByLabelText("Title");
    expect(title).toHaveFocus();
    expect(taken(title)).toEqual([]);
  });
});
