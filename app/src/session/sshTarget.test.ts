// Where a nested `ssh` goes (ticket 120, decision Q131): the command line read off the screen at
// the shell's `C` mark, parsed with ssh's own rules for the common flags, matched against the
// Inventory by name, address and port. Anything roster can't resolve fully is refused.
import { describe, expect, it } from "vitest";
import type { Host } from "../backend/types";
import { parseSsh, resolveHop } from "./sshTarget";

describe("parseSsh", () => {
  it.each([
    ["ssh esx-02", { destination: "esx-02", user: null, port: null, hostName: null }],
    ["ssh root@esx-02", { destination: "esx-02", user: "root", port: null, hostName: null }],
    ["ssh -l root esx-02", { destination: "esx-02", user: "root", port: null, hostName: null }],
    ["ssh -lroot esx-02", { destination: "esx-02", user: "root", port: null, hostName: null }],
    ["ssh -p 2222 10.0.0.12", { destination: "10.0.0.12", user: null, port: 2222, hostName: null }],
    ["ssh -p2222 10.0.0.12", { destination: "10.0.0.12", user: null, port: 2222, hostName: null }],
    ["ssh -tp 2222 esx-02", { destination: "esx-02", user: null, port: 2222, hostName: null }],
    ["ssh -4Avt -i ~/.ssh/id_ed25519 esx-02", { destination: "esx-02", user: null, port: null, hostName: null }],
    ["ssh -o User=ops -oPort=2200 esx-02", { destination: "esx-02", user: "ops", port: 2200, hostName: null }],
    ["ssh -o HostName=10.0.0.12 esx-02", { destination: "esx-02", user: null, port: null, hostName: "10.0.0.12" }],
    ["ssh -o user=ops esx-02", { destination: "esx-02", user: "ops", port: null, hostName: null }],
    ["ssh esx-02 -p 2222", { destination: "esx-02", user: null, port: 2222, hostName: null }],
    ["ssh esx-02 uptime -p", { destination: "esx-02", user: null, port: null, hostName: null }],
    ["ssh -L 8080:localhost:80 -N esx-02", { destination: "esx-02", user: null, port: null, hostName: null }],
    ["ssh -- esx-02", { destination: "esx-02", user: null, port: null, hostName: null }],
    ["ops@esx-01:~$ ssh esx-02".slice("ops@esx-01:~$ ".length), { destination: "esx-02", user: null, port: null, hostName: null }],
    ["/usr/bin/ssh ops@esx-02", { destination: "esx-02", user: "ops", port: null, hostName: null }],
    ["TERM=xterm ssh esx-02", { destination: "esx-02", user: null, port: null, hostName: null }],
    ["ssh a@b@esx-02", { destination: "esx-02", user: "a@b", port: null, hostName: null }],
    ["ssh -l ops ops@esx-02", { destination: "esx-02", user: "ops", port: null, hostName: null }],
  ])("reads %j", (command, want) => {
    expect(parseSsh(command)).toEqual({ ok: true, ...want });
  });

  it.each(["ls", "sudo ssh esx-02", "autossh esx-02", "mosh esx-02", "sshpass -p x ssh esx-02", "echo ssh esx-02", ""])(
    "says %j isn't an ssh",
    (command) => {
      expect(parseSsh(command)).toBeNull();
    },
  );

  it.each([
    ["ssh -J jump esx-02", /-J/],
    ["ssh -o ProxyJump=jump esx-02", /ProxyJump/],
    ["ssh -o ProxyCommand=nc esx-02", /ProxyCommand/],
    ["ssh -oStrictHostKeyChecking=no esx-02", /StrictHostKeyChecking/],
    ["ssh -o UserKnownHostsFile=/dev/null esx-02", /UserKnownHostsFile/],
    ["ssh -o HostKeyAlias=esx-02 10.0.0.66", /HostKeyAlias/],
    ["ssh -F ./cfg esx-02", /-F/],
    ["ssh -S /tmp/mux esx-02", /-S/],
    ["ssh -W esx-02:22 jump", /-W/],
    ["ssh -f esx-02", /-f/],
    ["ssh -G esx-02", /-G/],
    ["ssh -V", /-V/],
    ["ssh -P tag esx-02", /-P/],
    ["ssh 'esx-02'", /quote/],
    ["ssh esx-0?", /wildcard/],
    ["ssh esx-*", /wildcard/],
    ["ssh $HOST", /\$/],
    ["ssh esx-02; ls", /shell syntax/],
    ["ssh esx-02 | tee x", /shell syntax/],
    ["ssh ssh://ops@esx-02:2222", /ssh:\/\//],
    ["ssh -p 99999 esx-02", /port/],
    ["ssh -p x esx-02", /port/],
    ["ssh -p", /-p needs/],
    ["ssh -o HostName=%h.lab esx-02", /%/],
    ["ssh -l root ops@esx-02", /users/],
    ["ssh -o User=root -l ops esx-02", /users/],
    ["ssh -p 22 -o Port=2222 esx-02", /ports/],
    ["ssh -p 22 -p 2222 esx-02", /ports/],
    ["ssh @esx-02", /user/],
    ["ssh", /no destination/],
    ["ssh -t", /no destination/],
    ["ssh -Z esx-02", /-Z/],
  ])("refuses %j", (command, why) => {
    const parsed = parseSsh(command);
    expect(parsed?.ok).toBe(false);
    expect(parsed && !parsed.ok ? parsed.why : "").toMatch(why);
  });
});

const host = (name: string, ip: string, over: Partial<Host> = {}): Host => ({
  name,
  group: "lab",
  ip,
  type: "linux",
  product: "",
  title: "",
  description: "",
  reviewed: true,
  enroll: false,
  ssh: { user: "ops", port: 22, auth: `bw:${name} ssh` },
  web: null,
  ...over,
});

const INVENTORY = [
  host("esx-01", "10.0.0.11"),
  host("esx-02", "10.0.0.12"),
  host("appliance", "10.0.0.20", { ssh: { user: "admin", port: 2222, auth: "bw:appliance" } }),
  host("keyed", "10.0.0.30", { enroll: true, ssh: { user: "ops", port: 22, auth: "key" } }),
  host("agented", "10.0.0.31", { ssh: { user: "ops", port: 22, auth: "agent" } }),
  host("typed", "10.0.0.32", { ssh: { user: "ops", port: 22, auth: "prompt" } }),
  host("pending", "10.0.0.33", { reviewed: false }),
  host("twin-a", "10.0.0.40"),
  host("twin-b", "10.0.0.40"),
];

describe("resolveHop", () => {
  it.each([
    ["ssh esx-02", "esx-02"],
    ["ssh ESX-02", "esx-02"],
    ["ssh 10.0.0.12", "10.0.0.12"],
    ["ssh ops@esx-02", "esx-02"],
    ["ssh -o HostName=10.0.0.12 anything", "10.0.0.12"],
  ])("finds the Host %j goes to, and the prompt ssh will show", (command, target) => {
    expect(resolveHop(command, INVENTORY)).toEqual({
      known: true,
      host: "esx-02",
      target,
      address: "10.0.0.12",
      port: 22,
      user: "ops",
      sshFill: null,
      sudoFill: null,
    });
  });

  it("matches the port too", () => {
    expect(resolveHop("ssh -p 2222 admin@appliance", INVENTORY)).toMatchObject({ known: true, host: "appliance", port: 2222, user: "admin" });
    expect(resolveHop("ssh appliance", INVENTORY)).toMatchObject({ known: false, label: "appliance", why: expect.stringMatching(/2222/) });
  });

  it.each([
    ["ssh keyed", /key/],
    ["ssh agented", /key/],
    ["ssh typed", /no saved password/],
    ["ssh root@esx-02", /root/],
    ["ssh pending", /isn't reviewed/],
  ])("shows %j's Host but types nothing into its ssh", (command, why) => {
    const hop = resolveHop(command, INVENTORY);
    expect(hop).toMatchObject({ known: true });
    expect(hop?.known && hop.sshFill).toMatch(why);
  });

  it("leaves a key Host's sudo to roster serve, but not another user's", () => {
    expect(resolveHop("ssh keyed", INVENTORY)).toMatchObject({ sudoFill: null });
    expect(resolveHop("ssh root@esx-02", INVENTORY)).toMatchObject({ sudoFill: expect.stringMatching(/root/) });
  });

  it.each([
    ["ssh 10.0.0.99", "10.0.0.99", /isn't a Host/],
    ["ssh twin-a.lab", "twin-a.lab", /isn't a Host/],
    ["ssh 10.0.0.40", "10.0.0.40", /twin-a and twin-b/],
    ["ssh localhost", "localhost", /this machine/],
    ["ssh 127.0.0.1", "127.0.0.1", /this machine/],
    ["ssh -J jump esx-02", "esx-02", /-J/],
    ["ssh -t", "?", /no destination/],
  ])("doesn't know where %j goes", (command, label, why) => {
    expect(resolveHop(command, INVENTORY)).toEqual({ known: false, label, why: expect.stringMatching(why) });
  });

  it("isn't a hop when the command isn't an ssh", () => {
    expect(resolveHop("sudo -v", INVENTORY)).toBeNull();
  });
});
