// Filling a password prompt from the vault (ticket 119, decision Q129), through the App with the
// fake Backend and a stub terminal: the fake shell's `sudo …` asks for the Login's password
// without echo, the offer shows only while it does, `␣ p` fills it, and the password never
// reaches the page. The fake stands in for the core's probe: no prompt (or one that echoes) is
// refused there.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_LOGIN_PASSWORD, FAKE_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "./backend/fake";
import { FILL_API_VERSION, FillRefusal, NESTED_FILL_API_VERSION } from "./backend/types";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
// makeHosts: every third Host has a vault Login (bw:…), the rest log in with keys (auth: key).
const vaultHosts = hosts.hosts.filter((h) => h.reviewed && h.ssh.auth.startsWith("bw:"));
const vaultHost = vaultHosts[0]?.name ?? "";
const keyHosts = hosts.hosts.filter((h) => h.reviewed && h.ssh.auth === "key");
const keyHost = keyHosts[0]?.name ?? "";
// Every Host with `shell_hooks: true`: roster sends its hook line, so the shell's marks carry the
// Session's token (ticket 120).
const hooked = { ...hosts, hosts: hosts.hosts.map((h) => ({ ...h, shell_hooks: true })) };
/** Waits for roster's hook line to have gone (the login idle at its prompt for IDLE_MS). */
const hooksOn = () => new Promise((r) => setTimeout(r, 700));
const LEADER = "{Control>} {/Control}";
type User = ReturnType<typeof userEvent.setup>;

async function ready(scenario: Partial<FakeScenario> = {}) {
  const user = userEvent.setup();
  render(
    <App
      backend={fakeBackend({ hosts, apiVersion: NESTED_FILL_API_VERSION, ...scenario })}
      terminalView={StubTerminal}
      registries={builtinRegistries()}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

async function connect(user: User, name: string) {
  await user.keyboard(`${LEADER}f`);
  await user.keyboard(name);
  await user.keyboard("{Enter}");
  await within(output()).findByText(new RegExp(`Connected to ${name}`));
}

const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
const offer = () => screen.queryByRole("status", { name: "Password prompt" });
const messageLine = () => document.querySelector(".message-line") as HTMLElement;

async function sudo(user: User) {
  await user.keyboard("sudo -v{Enter}");
  await within(output()).findByText(/\[sudo\] password for admin:/);
}

describe("filling a password prompt", () => {
  it("offers the key only while the prompt is up, and fills it without the password reaching the page", async () => {
    const user = await ready();
    await connect(user, vaultHost);
    expect(offer()).toBeNull();
    await sudo(user);
    const note = await screen.findByRole("status", { name: "Password prompt" });
    expect(note).toHaveTextContent(`fill ${vaultHost}'s from the vault`);
    // No shell marks here: the offer says roster can't tell where the Session is.
    expect(note).toHaveTextContent(`can't tell whether you're still on ${vaultHost}`);
    expect(within(note).getByRole("button", { name: "Fill" })).toBeInTheDocument();

    await user.keyboard(`${LEADER}p`);
    // Gone at once: a second press can't type it again.
    expect(offer()).toBeNull();
    await within(output()).findByText(/\[sudo ok\]/);
    expect(document.body.innerHTML).not.toContain(FAKE_LOGIN_PASSWORD);
    // The keys go back to the shell, as after any command.
    expect(document.activeElement).toHaveAccessibleName("terminal input");
  });

  it("fills from the offer's button too, keeping the terminal's focus", async () => {
    const user = await ready();
    await connect(user, vaultHost);
    await sudo(user);
    await user.click(await screen.findByRole("button", { name: "Fill" }));
    await within(output()).findByText(/\[sudo ok\]/);
  });

  it("says there's no prompt when there's none, and types nothing", async () => {
    const user = await ready();
    await connect(user, vaultHost);
    await user.keyboard(`${LEADER}p`);
    await waitFor(() => expect(messageLine()).toHaveTextContent(/No password prompt/));
    expect(output()).not.toHaveTextContent(/sudo ok|Sorry/);
  });

  it("shows roster's refusal, as a Login with no saved password", async () => {
    const user = await ready();
    await connect(user, keyHost);
    await sudo(user);
    await user.keyboard(`${LEADER}p`);
    await waitFor(() => expect(messageLine()).toHaveTextContent(/has no saved password to fill/));
    expect(output()).not.toHaveTextContent(/sudo ok/);
  });

  it("fills a key-login Host's sudo prompt from its sudo: reference", async () => {
    const user = await ready({ sudoRefs: { [keyHost]: `bw:${keyHost} sudo` } });
    await connect(user, keyHost);
    await sudo(user);
    await user.keyboard(`${LEADER}p`);
    await within(output()).findByText(/\[sudo ok\]/);
  });

  it("offers nothing at a prompt that doesn't say it's the login user's", async () => {
    const user = await ready();
    await connect(user, vaultHost);
    await user.keyboard("su{Enter}");
    await within(output()).findByText(/Password:/);
    await new Promise((r) => setTimeout(r, 50));
    expect(offer()).toBeNull();
    await user.keyboard(`${LEADER}p`);
    await waitFor(() => expect(messageLine()).toHaveTextContent(/No password prompt/));
  });

  it("shows serve's refusal of a prompt for another Host", async () => {
    const user = await ready({
      fillRefusals: { [vaultHost]: { code: FillRefusal.refused, message: `won't fill on ${vaultHost}: the prompt asks for root@10.0.0.9's password` } },
    });
    await connect(user, vaultHost);
    await sudo(user);
    await user.keyboard(`${LEADER}p`);
    await waitFor(() => expect(messageLine()).toHaveTextContent(/root@10\.0\.0\.9/));
  });

  it("offers nothing, and says why, while an ssh runs under marks that aren't roster's own", async () => {
    const user = await ready({ shellMarks: true });
    await connect(user, vaultHost);
    await user.keyboard("ssh other{Enter}");
    await within(output()).findByText(/Connected to other/);
    await sudo(user);
    const note = await screen.findByRole("status", { name: "Password prompt" });
    expect(note).toHaveTextContent(/ssh other.*won't fill it/);
    expect(note).not.toHaveTextContent(/can't tell whether you're still/);
    expect(within(note).queryByRole("button")).toBeNull();
    await user.keyboard(`${LEADER}p`);
    await waitFor(() => expect(messageLine()).toHaveTextContent(/may be another machine's/));
    expect(output()).not.toHaveTextContent(/sudo ok/);
  });

  it("fills nothing more after that ssh when the marks aren't roster's own, and says how to fix it", async () => {
    const user = await ready({ shellMarks: true });
    await connect(user, vaultHost);
    await user.keyboard("ssh other{Enter}");
    await within(output()).findByText(/Connected to other/);
    await user.keyboard("exit{Enter}");
    await within(output()).findByText(/logout/);
    await sudo(user);
    const note = await screen.findByRole("status", { name: "Password prompt" });
    expect(note).toHaveTextContent(/aren't roster's own.*shell hooks/);
    expect(within(note).queryByRole("button")).toBeNull();
  });

  it("offers it again once that ssh has ended, under roster's own marks", async () => {
    const user = await ready({ hosts: hooked });
    await connect(user, vaultHost);
    await hooksOn();
    await user.keyboard("ssh other{Enter}");
    await within(output()).findByText(/Connected to other/);
    await user.keyboard("exit{Enter}");
    await within(output()).findByText(/logout/);
    await sudo(user);
    expect(await screen.findByRole("button", { name: "Fill" })).toBeInTheDocument();
    await user.keyboard(`${LEADER}p`);
    await within(output()).findByText(/\[sudo ok\]/);
  });

  it("isn't offered by an older roster, and the key says why", async () => {
    const user = await ready({ apiVersion: FILL_API_VERSION - 1 });
    await connect(user, vaultHost);
    await sudo(user);
    expect(offer()).toBeNull();
    await user.keyboard(`${LEADER}p`);
    await waitFor(() => expect(messageLine()).toHaveTextContent(/needs a newer roster \(API version 25/));
  });
});

describe("a nested ssh to another Host (ticket 120)", () => {
  // The Session is on a key Host; the ssh goes to a Host whose Login is in the vault.
  const there = vaultHosts[1]?.name ?? "";
  // The Session's row in the Sidebar's Sessions section (the default; tabs are an option).
  const tab = () => screen.getAllByRole("treeitem").find((el) => el.id.startsWith("sb-session-")) as HTMLElement;

  async function nested(user: User, to = there, from = keyHost) {
    await connect(user, from);
    await hooksOn();
    await user.keyboard(`ssh ${to}{Enter}`);
  }

  it("shows the Host the Session is on now, until that ssh ends", async () => {
    const user = await ready({ hosts: hooked });
    await nested(user, keyHosts[1]?.name);
    await within(output()).findByText(new RegExp(`Connected to ${keyHosts[1]?.name}`));
    await waitFor(() => expect(tab()).toHaveAccessibleName(new RegExp(`${keyHost}.*now on ${keyHosts[1]?.name}`)));
    expect(screen.getByRole("status", { name: "Where this Session is" })).toHaveTextContent(`Now on ${keyHosts[1]?.name}`);
    // A key Login: nothing is typed, nothing offered.
    expect(offer()).toBeNull();
    await user.keyboard("exit{Enter}");
    await waitFor(() => expect(tab()).not.toHaveAccessibleName(/now on/));
  });

  it("fills that Host's ssh prompt from its own Login, without the password reaching the page", async () => {
    const user = await ready({ hosts: hooked });
    await nested(user);
    await within(output()).findByText(new RegExp(`admin@${there}'s password:`));
    const note = await screen.findByRole("status", { name: "Password prompt" });
    expect(note).toHaveTextContent(`ssh's password prompt · fill ${there}'s from the vault`);
    await user.keyboard(`${LEADER}p`);
    await within(output()).findByText(new RegExp(`Connected to ${there}`));
    expect(document.body.innerHTML).not.toContain(FAKE_LOGIN_PASSWORD);
    expect(tab()).toHaveAccessibleName(new RegExp(`now on ${there}`));
  });

  it("fills that Host's sudo at the first command its marked shell runs", async () => {
    const user = await ready({ hosts: hooked, innerMarks: true });
    await nested(user);
    await within(output()).findByText(new RegExp(`admin@${there}'s password:`));
    await user.keyboard(`${LEADER}p`);
    await within(output()).findByText(new RegExp(`Connected to ${there}`));
    await sudo(user);
    const note = await screen.findByRole("status", { name: "Password prompt" });
    expect(note).toHaveTextContent(`fill ${there}'s from the vault`);
    await user.keyboard(`${LEADER}p`);
    await within(output()).findByText(/\[sudo ok\]/);
  });

  it("never fills the Session's own Host's password into the far shell, which marks a D before its first prompt", async () => {
    // The Session's Host has a vault Login too: taking the far shell for its own would leak it.
    const user = await ready({ hosts: hooked, innerMarks: true });
    await nested(user, there, vaultHost);
    await within(output()).findByText(new RegExp(`admin@${there}'s password:`));
    await user.keyboard(`${LEADER}p`);
    await within(output()).findByText(new RegExp(`Connected to ${there}`));
    await sudo(user);
    const note = await screen.findByRole("status", { name: "Password prompt" });
    expect(note).toHaveTextContent(`fill ${there}'s from the vault`);
    expect(tab()).toHaveAccessibleName(new RegExp(`now on ${there}`));
  });

  it("offers nothing without the shell's marks, and says so", async () => {
    const user = await ready();
    await connect(user, keyHost);
    await user.keyboard(`ssh ${there}{Enter}`);
    await within(output()).findByText(new RegExp(`admin@${there}'s password:`));
    const note = await screen.findByRole("status", { name: "Password prompt" });
    expect(note).toHaveTextContent(/can't tell where this ssh went/);
    expect(within(note).queryByRole("button")).toBeNull();
    await user.keyboard(`${LEADER}p`);
    await waitFor(() => expect(messageLine()).toHaveTextContent(/can't tell where this ssh went/));
  });

  it("shows the Host but offers no fill on a roster before API 26", async () => {
    const user = await ready({ hosts: hooked, apiVersion: FILL_API_VERSION });
    await nested(user);
    await within(output()).findByText(new RegExp(`admin@${there}'s password:`));
    expect(tab()).toHaveAccessibleName(new RegExp(`now on ${there}`));
    const note = await screen.findByRole("status", { name: "Password prompt" });
    expect(note).toHaveTextContent(/newer roster \(API 26\)/);
  });
});
