// Lazy `:help` (T213, decision Q189), through the App with the fake Backend: the guides' text is a
// chunk of its own that nothing here loads up front, so each test reaches it the way a user does.
// `:helpgrep`, `:help TOPIC`, Tab completion, the tutor, the Plugin API's help and `:version` all
// still work. The first test runs with the text not loaded yet. (HelpView's wait, and the loading
// state past 150 ms, are text.test.ts's.)
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { helpText } from "./help/text";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

async function ready() {
  const user = userEvent.setup();
  render(<App backend={fakeBackend({ hosts: makeHosts(4) })} terminalView={StubTerminal} registries={builtinRegistries()} platform={memoryPlatform()} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const help = () => screen.getByRole("complementary", { name: "Help" });
/** Help, once it's open: a guide opens when its text is here. */
const opened = () => screen.findByRole("complementary", { name: "Help" });
const heading = () => within(help()).getAllByRole("heading", { level: 1 })[0];

describe("lazy :help", () => {
  it(":helpgrep finds a guide's text, loading it as the finder opens", async () => {
    const user = await ready();
    expect(helpText.ready()).toBe(false);
    await user.keyboard(`${LEADER}:helpgrep bytecode{Enter}`);
    const grep = await screen.findByRole("dialog", { name: /search every help page/i });
    expect(await within(grep).findByRole("option", { name: /The sandbox/ })).toHaveTextContent(/bytecode/);
    expect(helpText.ready()).toBe(true);
  });

  it(":help TOPIC opens a guide at its heading, and Tab completes a guide's headings", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help config#the-sa{Tab}`);
    expect(screen.getByRole("combobox", { name: "Command" })).toHaveValue("help config#the-sandbox");
    await user.keyboard("{Enter}");
    const panel = await opened();
    expect(within(panel).getByRole("heading", { name: "The sandbox" })).toHaveClass("help-target");
    expect(heading()).toHaveTextContent("The Config: init.lua");
  });

  it("the Plugin API's help: an entry by its tag, and the stubs made from plugin-api.json", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help roster.inventory.host(){Enter}`);
    await opened();
    expect(heading()).toHaveTextContent("The Plugin API");
    expect(help().querySelector(".help-target")).toHaveTextContent("roster.inventory.host(name)");
    await user.keyboard(`{Escape}${LEADER}:help plugin-types{Enter}`);
    expect(heading()).toHaveTextContent("roster.lua: the Plugin API's types");
    expect(help()).toHaveTextContent("---@meta roster");
    expect(help()).toHaveTextContent("function roster.inventory.host(name) end");
  });

  it(":version shows the build's notices", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:version{Enter}`);
    await opened();
    expect(heading()).toHaveTextContent(/^roster \d/);
    expect(within(help()).getByRole("heading", { name: "Third-party notices" })).toBeInTheDocument();
  });

  it(":tutor opens, and its link to Getting started opens the guide", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help tutor{Enter}`);
    expect(heading()).toHaveTextContent(/tutor/i);
    await user.keyboard(`{Escape}${LEADER}:help index{Enter}`);
    await user.click(within(help()).getByRole("link", { name: "Getting started" }));
    expect(await within(help()).findByRole("heading", { level: 1, name: "Getting started with roster" })).toBeInTheDocument();
  });
});
