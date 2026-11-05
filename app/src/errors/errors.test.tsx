// Clean connection errors (ticket 26, docs/app/errors.md) through the App with the fake Backend: the
// Session pane's error panel for roster's refusals and ssh's failures, and `:check HOST`.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { FAKE_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "../backend/fake";
import { CHECK_STEPS, type HostCheck } from "../backend/types";
import { memoryPlatform } from "../platform/memory";
import { StubTerminal } from "../terminal/StubTerminal";

const hosts = makeHosts(12);
const keyHost = hosts.hosts.find((h) => h.reviewed && h.enroll)!.name;
const pwHost = hosts.hosts.find((h) => h.reviewed && !h.enroll)!.name;
const LEADER = "{Control>} {/Control}";

async function ready(scenario: Partial<FakeScenario> = {}) {
  const user = userEvent.setup();
  const platform = memoryPlatform();
  render(<App backend={fakeBackend({ hosts, ...scenario })} terminalView={StubTerminal} platform={platform} />);
  await screen.findByText(/12 hosts/i);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, platform };
}

async function command(user: ReturnType<typeof userEvent.setup>, line: string) {
  await user.keyboard(`${LEADER}:`);
  await user.keyboard(`${line}{Enter}`);
}

const problem = () => screen.findByRole("alert");

describe("the Session's error panel", () => {
  it("names the Host, says what happened and where, gives the fix, and keeps ssh's text under Details", async () => {
    const raw = "ssh: connect to host 10.0.0.6 port 2222: Connection refused";
    const { user } = await ready({ sshFailures: { [keyHost]: `${raw}\r\n` } });
    await command(user, `connect ${keyHost}`);
    const panel = await problem();
    expect(within(panel).getByRole("heading")).toHaveTextContent(keyHost);
    expect(panel).toHaveTextContent(`${keyHost} (10.0.0.6:2222) refused the connection`);
    expect(within(panel).getByText("Where")).toBeInTheDocument();
    expect(panel).toHaveTextContent(/roster\.yml.*the Host/);
    expect(panel).toHaveTextContent(/Check the port in roster\.yml/);
    const details = within(panel).getByText("Details").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent(raw);
    expect(within(panel).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Run :check" })).toBeInTheDocument();
  });

  it("shows roster's near names for a vault item that isn't there (32)", async () => {
    const message = `no vault item named '${pwHost} shh' (ssh Login of ${pwHost}) - did you mean: '${pwHost} ssh'`;
    const { user } = await ready({
      refusals: { [pwHost]: { code: 32, message, data: { near: [`${pwHost} ssh`, `${pwHost} root`], fix: "fix the name" } } },
    });
    await command(user, `connect ${pwHost}`);
    const panel = await problem();
    expect(panel).toHaveTextContent(/^.*No vault item named/);
    expect(panel).toHaveTextContent(/the vault.*roster\.yml/);
    expect(within(panel).getByRole("list", { name: /similar item names/i })).toHaveTextContent(`${pwHost} ssh${pwHost} root`);
    expect(panel).toHaveTextContent("Fix the name");
  });

  it("lists the matching items for a duplicate name (33): name, last edited, URIs", async () => {
    const matches = [
      { name: `${pwHost} ssh`, revised: "2026-09-01", uris: ["ssh://10.0.0.6"] },
      { name: `${pwHost} ssh`, revised: "2026-10-20", uris: ["https://10.0.0.6"] },
    ];
    const { user } = await ready({
      refusals: { [pwHost]: { code: 33, message: `2 vault items are named '${pwHost} ssh'`, data: { matches } } },
    });
    await command(user, `connect ${pwHost}`);
    const table = within(await problem()).getByRole("table", { name: /matching vault items/i });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(table).toHaveTextContent(/2026-09-01.*ssh:\/\/10\.0\.0\.6.*2026-10-20.*https:\/\/10\.0\.0\.6/);
  });

  it("shows a changed host key's fingerprint and how to verify it, and never offers to accept it (43)", async () => {
    const changed = [
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
      "The fingerprint for the ED25519 key sent by the remote host is",
      "SHA256:NEWnewNEW.",
      "Offending ED25519 key in /home/me/.ssh/roster_known_hosts:3",
      "Host key verification failed.",
    ].join("\r\n");
    const { user } = await ready({ sshFailures: { [keyHost]: changed } });
    await command(user, `connect ${keyHost}`);
    const panel = await problem();
    expect(panel).toHaveTextContent(`${keyHost}'s host key changed. Not connecting.`);
    expect(panel).toHaveTextContent("SHA256:NEWnewNEW");
    expect(panel).toHaveTextContent("/home/me/.ssh/roster_known_hosts:3");
    expect(panel).toHaveTextContent(/ssh-keygen -lf/);
    for (const b of within(panel).getAllByRole("button")) expect(b).not.toHaveAccessibleName(/accept|trust|yes|continue/i);
  });

  it("shows the command to copy when serve can't run it itself (21: roster sync)", async () => {
    const { user, platform } = await ready({
      sessionRefusal: { code: 21, message: `${keyHost} isn't in this box's ssh config - run \`roster sync\`` },
    });
    await command(user, `connect ${keyHost}`);
    const panel = await problem();
    expect(within(panel).getAllByText("roster sync", { selector: "code" }).length).toBeGreaterThan(0);
    await user.click(within(panel).getByRole("button", { name: "Copy" }));
    expect(platform.clipboardText()).toBe("roster sync");
  });

  // `roster setup --only NAME` also takes a group, type or product named NAME; `--host NAME` (API 29,
  // #461) takes that Host alone. An older roster has only --only.
  it.each([
    [29, "--host"],
    [28, "--only"],
  ])("on API %i, says roster setup %s for this Host when the key is refused (46)", async (apiVersion, flag) => {
    const { user, platform } = await ready({
      apiVersion,
      sessionRefusal: { code: 46, message: `${keyHost} didn't accept this Box's key` },
    });
    await command(user, `connect ${keyHost}`);
    const panel = await problem();
    expect(panel).toHaveTextContent(`Run roster setup ${flag} ${keyHost} to install this Box's key`);
    await user.click(within(panel).getByRole("button", { name: "Copy" }));
    expect(platform.clipboardText()).toBe(`roster setup ${flag} ${keyHost}`);
  });

  it.each([
    [30, "--host"],
    [2, "--only"],
  ])("on API %i, says roster setup %s to record an unknown host key (44)", async (apiVersion, flag) => {
    const { user, platform } = await ready({
      apiVersion,
      sessionRefusal: { code: 44, message: `no recorded host key for ${keyHost}` },
    });
    await command(user, `connect ${keyHost}`);
    const panel = await problem();
    expect(panel).toHaveTextContent(`then run roster setup ${flag} ${keyHost} to record it`);
    await user.click(within(panel).getByRole("button", { name: "Copy" }));
    expect(platform.clipboardText()).toBe(`roster setup ${flag} ${keyHost}`);
  });

  it("offers Reconnect for a dropped Session", async () => {
    const { user } = await ready({ sshFailures: { [keyHost]: "client_loop: send disconnect: Connection reset by peer\r\n" } });
    await command(user, `connect ${keyHost}`);
    const panel = await problem();
    expect(panel).toHaveTextContent(/connection reset/);
    expect(within(panel).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("shows an askpass reason as its own error, not ssh's 'Permission denied' (36)", async () => {
    const { user } = await ready({
      vault: { status: "unlocked" },
      sshFailures: {
        [pwHost]: `roster askpass: [36] ${pwHost} asked something roster won't answer: 'New password:' - log in by hand once to deal with it\r\nroot@${pwHost}: Permission denied (publickey,password).\r\n`,
      },
    });
    await command(user, `connect ${pwHost}`);
    const panel = await problem();
    expect(panel).toHaveTextContent(/asked something roster won't answer: 'New password:'/);
    expect(within(panel).getByText(`ssh ${pwHost}`, { selector: "code" })).toBeInTheDocument();
  });

  it("never shows the vault's master password", async () => {
    const { user } = await ready({ refusals: { [keyHost]: { code: 30, message: `no SSH user for ${keyHost}` } } });
    await command(user, `connect ${keyHost}`);
    await problem();
    expect(document.body.textContent).not.toContain(FAKE_PASSWORD);
  });

  it("Run :check from the panel opens the check for that Host", async () => {
    const { user } = await ready({ sshFailures: { [keyHost]: "ssh: connect to host 10.0.0.6 port 22: Connection refused\r\n" } });
    await command(user, `connect ${keyHost}`);
    await user.click(within(await problem()).getByRole("button", { name: "Run :check" }));
    expect(await screen.findByRole("region", { name: `Check ${keyHost}` })).toBeInTheDocument();
  });
});

function failingAt(host: string, failAt: number, fail: HostCheck["steps"][number]): HostCheck {
  return {
    host,
    ok: false,
    steps: CHECK_STEPS.map((step, i) =>
      i < failAt
        ? { step, status: "ok" as const, message: `${step} fine` }
        : i === failAt
          ? { ...fail, step }
          : { step, status: "skipped" as const, message: "an earlier step failed" },
    ),
  };
}

describe(":check HOST", () => {
  it("lists the eight steps with their status, the failing one expanded with its fix and Details", async () => {
    const check = failingAt(keyHost, 5, {
      step: "tcp",
      status: "fail",
      code: 42,
      message: `${keyHost} (10.0.0.5:22) didn't answer within 5 s`,
      fix: "retry later; is the Host up and the network path open? 10.0.0.5 is in 10.0.0.0/8 (rate_limited: in roster.yml): its SSH rate limiter stops answering for a few minutes after many connections, so wait a few minutes, don't retry in a loop",
      details: "timed out",
    });
    const { user } = await ready({ checks: { [keyHost]: check } });
    await command(user, `check ${keyHost}`);
    const panel = await screen.findByRole("region", { name: `Check ${keyHost}` });
    const items = await within(panel).findAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-step"))).toEqual([...CHECK_STEPS]);
    expect(items.map((li) => li.getAttribute("data-status"))).toEqual(["ok", "ok", "ok", "ok", "ok", "fail", "skipped", "skipped"]);
    const failed = items[5]!;
    expect(failed).toHaveTextContent("didn't answer within 5 s");
    expect(failed).toHaveTextContent(/rate limiter/);
    expect(failed).toHaveTextContent("the network");
    expect(within(failed).getByText("Details").closest("details")).toHaveTextContent("timed out");
    expect(items[0]).not.toHaveTextContent(/Where/);
    // The check isn't a tab: no Retry (that would reconnect whatever tab is current).
    expect(within(failed).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(within(failed).getByRole("button", { name: "Run :check" })).toBeInTheDocument();
  });

  it("shows both fingerprints for a changed host key", async () => {
    const check = failingAt(keyHost, 6, {
      step: "host-key",
      status: "fail",
      code: 43,
      message: `${keyHost}'s host key changed - not connecting`,
      data: { recorded: ["SHA256:OLDold"], offered: "SHA256:NEWnew" },
    });
    const { user } = await ready({ checks: { [keyHost]: check } });
    await command(user, `check ${keyHost}`);
    const panel = await screen.findByRole("region", { name: `Check ${keyHost}` });
    await waitFor(() => expect(panel).toHaveTextContent(/Recorded.*SHA256:OLDold.*Offered.*SHA256:NEWnew/));
  });

  it("says all is well when every step passes", async () => {
    const { user } = await ready();
    await command(user, `check ${keyHost}`);
    const panel = await screen.findByRole("region", { name: `Check ${keyHost}` });
    expect(await within(panel).findByText(/All checks passed/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("region", { name: `Check ${keyHost}` })).toBeNull();
  });

  it("says roster is too old for :check before API version 2", async () => {
    const { user } = await ready({ apiVersion: 1 });
    await command(user, `check ${keyHost}`);
    expect(await screen.findByRole("status")).toHaveTextContent(/needs a newer roster/);
  });

  it("says which Host is unknown", async () => {
    const { user } = await ready();
    await command(user, "check nope");
    expect(await screen.findByRole("status")).toHaveTextContent("No Host named nope");
  });
});
