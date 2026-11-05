// Ticket 12 through the App with the fake Backend: `:publish` (and the panel's Publish… button)
// shows the diff for a last look and roster's commit message, editable; Publish commits and pushes
// (`changes.publish`), then says the commit's hash. A refusal comes from the error catalog and keeps
// the Pending changes. It works the same in Standard and Focus.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, FAKE_COMMIT, fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import { PublishError } from "./backend/types";
import { defaultOptions, type Options } from "./keymap";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";
import { onMessageLine } from "./test-messageLine";

const LEADER = "{Control>} {/Control}";
const pendingScenario = fixtures["edit-pending"] as FakeScenario;

async function ready(scenario: FakeScenario = pendingScenario, options: Partial<Options> = {}) {
  const user = userEvent.setup();
  const backend = fakeBackend(scenario);
  render(
    <App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} options={{ ...defaultOptions, ...options }} />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend };
}

const statusbar = () => document.querySelector(".statusbar") as HTMLElement;
const panel = () => screen.findByRole("region", { name: "Pending changes" });

async function openPublish(user: ReturnType<typeof userEvent.setup>) {
  await within(statusbar()).findByRole("button", { name: /2 Pending changes/ });
  await user.keyboard(`${LEADER}:publish{Enter}`);
  return screen.findByRole("form", { name: "Publish the Pending changes" });
}

describe(":publish", () => {
  it("shows the diff and roster's message, focused, then publishes with Ctrl+Enter and names the commit", async () => {
    const { user, backend } = await ready();
    const form = await openPublish(user);
    expect(within(await panel()).getByLabelText("The diff of roster.yml")).toHaveTextContent("title: Build box");
    const message = within(form).getByLabelText("Commit message");
    expect(message).toHaveFocus();
    expect(message).toHaveValue(
      "roster: change 2 Hosts\n\n- change linux-1-000 (title, description)\n- change esxi-2-001 (type)",
    );
    await user.keyboard("{Control>}{Enter}{/Control}");
    const done = await within(await panel()).findByRole("status");
    expect(done).toHaveTextContent(`Published ${FAKE_COMMIT.slice(0, 7)} to origin/main`);
    expect(done).toHaveTextContent(/ssh config follows/);
    expect((await backend.pendingChanges()).count).toBe(0);
    expect(statusbar()).not.toHaveTextContent(/Pending change/);
    expect(await screen.findByText(new RegExp(`Published ${FAKE_COMMIT.slice(0, 7)}`), { selector: ".message-line" })).toBeInTheDocument();
  });

  it("after a Publish roster answered too late for, checks and names the commit it made", async () => {
    const { user } = await ready({ ...pendingScenario, lateAnswers: true });
    await openPublish(user);
    await user.keyboard("{Control>}{Enter}{/Control}");
    const done = await within(await panel()).findByRole("status");
    expect(done).toHaveTextContent(`Published ${FAKE_COMMIT.slice(0, 7)} to origin/main`);
    expect(done).toHaveTextContent(/answered late/);
  });

  it("publishes the message as edited", async () => {
    const { user } = await ready();
    const form = await openPublish(user);
    const message = within(form).getByLabelText("Commit message");
    await user.clear(message);
    await user.type(message, "Rack 1 tidy-up{Enter}{Enter}Per the audit.");
    expect(message).toHaveValue("Rack 1 tidy-up\n\nPer the audit.");           // Enter is a new line
    await user.click(within(form).getByRole("button", { name: "Publish" }));
    const done = await within(await panel()).findByRole("status");
    expect(done).toHaveTextContent("Rack 1 tidy-up");
  });

  it("won't publish an empty message", async () => {
    const { user } = await ready();
    const form = await openPublish(user);
    await user.clear(within(form).getByLabelText("Commit message"));
    expect(within(form).getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("opens from the panel's Publish… button, and Esc goes back to the diff", async () => {
    const { user } = await ready();
    await user.click(await within(statusbar()).findByRole("button", { name: /2 Pending changes/ }));
    await user.click(within(await panel()).getByRole("button", { name: "Publish…" }));
    expect(await screen.findByRole("form", { name: "Publish the Pending changes" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("form", { name: "Publish the Pending changes" })).toBeNull();
    expect(await panel()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull();
  });

  it("shows a refusal from the catalog and keeps the Pending changes", async () => {
    const { user, backend } = await ready({
      ...pendingScenario,
      publishRefusal: {
        code: PublishError.remoteMoved,
        message: "someone published roster.yml to origin/main since this box pulled (1 new commit), so roster won't publish over it",
        data: { fix: "discard your Pending changes, :pull, and make them again", details: "git's words" },
      },
    });
    const form = await openPublish(user);
    await user.click(within(form).getByRole("button", { name: "Publish" }));
    const alert = await within(await panel()).findByRole("alert");
    expect(alert).toHaveTextContent(/Someone published roster.yml to origin\/main/);
    expect(alert).toHaveTextContent("the infra repo");
    expect(alert).toHaveTextContent(/discard your Pending changes, :pull/i);
    expect(within(alert).getByText("Details")).toBeInTheDocument();
    expect((await backend.pendingChanges()).count).toBe(2);
    expect(within(statusbar()).getByRole("button", { name: /2 Pending changes/ })).toBeInTheDocument();
    expect(within(form).getByLabelText("Commit message")).toBeInTheDocument();      // still there to try again
  });

  it("says when this Box's ssh config didn't follow", async () => {
    const { user } = await ready({ ...pendingScenario, publishSyncError: "can't write ~/.ssh/config.d/roster" });
    const form = await openPublish(user);
    await user.click(within(form).getByRole("button", { name: "Publish" }));
    const done = await within(await panel()).findByRole("status");
    expect(done).toHaveTextContent(/Published/);
    expect(done).toHaveTextContent(/can't write ~\/\.ssh\/config\.d\/roster/);
    expect(done).toHaveTextContent("roster sync");
  });

  it("with nothing pending, says so", async () => {
    const { user } = await ready(fixtures.publish as FakeScenario);
    await user.keyboard(`${LEADER}:publish{Enter}`);
    expect(await within(await panel()).findByText(/No Pending changes/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Publish the Pending changes" })).toBeNull();
  });

  it("needs a roster that speaks API 7", async () => {
    const { user } = await ready({ ...pendingScenario, apiVersion: 6 });
    await within(statusbar()).findByRole("button", { name: /2 Pending changes/ });
    await user.keyboard(`${LEADER}:publish{Enter}`);
    expect(await screen.findByText(onMessageLine(/:publish needs a newer roster\. Update roster on this Box\./))).toBeInTheDocument();
    await user.click(within(statusbar()).getByRole("button", { name: /2 Pending changes/ }));
    expect(within(await panel()).queryByRole("button", { name: "Publish…" })).toBeNull();
  });

  it("works the same in Focus mode", async () => {
    const { user } = await ready(pendingScenario, { defaultMode: "focus" });
    expect(document.querySelector(".screen.app")?.getAttribute("data-view")).toBe("focus");
    await user.keyboard(`${LEADER}:publish{Enter}`);
    const form = await screen.findByRole("form", { name: "Publish the Pending changes" });
    await user.click(within(form).getByRole("button", { name: "Publish" }));
    expect(await within(await panel()).findByRole("status")).toHaveTextContent(/Published/);
  });
});
