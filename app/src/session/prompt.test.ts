// The fill key's offer (ticket 119, decision Q129): only sudo's own prompt for the Session's login
// user, read off a terminal's screen; with OSC 133 marks, only while the command running is sudo
// itself and has printed nothing but sudo's own lines. Refuse whenever in doubt.
import { afterEach, describe, expect, it } from "vitest";
import type { Host } from "../backend/types";
import { mayReachElsewhere } from "./commandLine";
import { PromptWatch, sudoOnly } from "./prompt";

const watches: PromptWatch[] = [];
async function fed(...chunks: string[]): Promise<PromptWatch> {
  const w = new PromptWatch({ cols: 80, rows: 24 }, "ops");
  watches.push(w);
  for (const c of chunks) await w.write(c);
  return w;
}
afterEach(() => watches.splice(0).forEach((w) => w.dispose()));

const A = "\x1b]133;A\x07";
const B = "\x1b]133;B\x07";
const C = "\x1b]133;C\x07";
const D = (code: number) => `\x1b]133;D;${code}\x07`;
const SUDO = "[sudo] password for ops: ";
/** A marked shell runs `command`, which asks for sudo's password. */
const marked = (command: string, before = "") => [`${A}ops@esx:~$ ${B}`, command, `\r\n${C}${before}${SUDO}`];

describe("PromptWatch without marks", () => {
  it("offers sudo's prompt for the login user, and says it can't tell where the Session is", async () => {
    const w = await fed(`ops@esx:~$ sudo -v\r\n${SUDO}`);
    expect(w.prompt()).toEqual({ line: "[sudo] password for ops:", elsewhere: null, marked: false, kind: "sudo", hop: null });
  });

  it.each([
    "[sudo] password for root: ",
    "Password: ",
    "Password for ops: ",
    "ops@esx's password: ",
    "Enter passphrase for key '/home/ops/.ssh/id_ed25519': ",
    "ops@esx:~$ ",
    `${SUDO}typed`,
  ])("offers nothing at %j", async (line) => {
    expect((await fed(line)).prompt()).toBeNull();
  });

  it("reads the screen: colours, a rewritten line, a split escape", async () => {
    expect((await fed("\x1b[1m[sudo]\x1b", "[0m password for ops: ")).prompt()?.line).toBe("[sudo] password for ops:");
    expect((await fed("progress 50%\r[sudo] password for ops: ")).prompt()?.line).toBe("[sudo] password for ops:");
  });

  it("follows the line it's on, and offers nothing once a fill is spent until a new prompt shows", async () => {
    const w = await fed(SUDO);
    w.spent();
    expect(w.prompt()).toBeNull();
    await w.write("\r\nSorry, try again.\r\n");
    expect(w.prompt()).toBeNull();
    await w.write(SUDO);
    expect(w.prompt()).not.toBeNull();
  });
});

describe("PromptWatch with marks: only while sudo itself runs", () => {
  it.each(["sudo -v", "sudo apt upgrade", "FOO=1 sudo -u ops make install", "/usr/bin/sudo -l", "sudo -i"])(
    "offers it while %j runs",
    async (command) => {
      const w = await fed(...marked(command));
      expect(w.prompt()).toEqual({ line: "[sudo] password for ops:", elsewhere: null, marked: true, kind: "sudo", hop: null });
    },
  );

  it.each([
    ["ssh other", /ssh other/],
    ["sudo -u x ssh other", /sudo -u x ssh other/],
    ["env ssh other", /env ssh other/],
    ["FOO=1 ssh other", /FOO=1 ssh other/],
    ["docker exec -it web sh", /docker exec/],
    ["kubectl exec -it pod -- sh", /kubectl/],
    ["sudo docker exec -it web sudo -v", /docker/],
    ["sudo bash -c 'ssh other'", /ssh other/],
    ["ls | sudo tee /etc/x", /tee/],
    ["time sudo -v", /time sudo/],
    ["make deploy", /make deploy/],
  ])("refuses while %j runs", async (command, says) => {
    const w = await fed(...marked(command));
    expect(w.prompt()?.elsewhere).toMatch(says);
  });

  it("refuses once the command has printed more than sudo's own lines", async () => {
    const w = await fed(...marked("sudo -i", `${SUDO}\r\nroot@esx:~# ssh other\r\nops@other:~$ sudo -v\r\n`));
    expect(w.prompt()?.elsewhere).toMatch(/printed/);
  });

  it("reads a C before the line feed as the command line's, not output (pwsh)", async () => {
    const w = await fed(`${A}PS C:\\> ${B}`, `sudo -v${C}\r\n${SUDO}`);
    expect(w.prompt()).toEqual({ line: "[sudo] password for ops:", elsewhere: null, marked: true, kind: "sudo", hop: null });
  });

  it("offers it again after a wrong password", async () => {
    const w = await fed(...marked("sudo -v", `${SUDO}\r\nSorry, try again.\r\n`));
    expect(w.prompt()?.elsewhere).toBeNull();
  });

  it("reads the command line off the screen, history recall and redraws included", async () => {
    // Up-arrow brought back `ssh other`: the shell redrew the line in place.
    const w = await fed(`${A}ops@esx:~$ ${B}`, "sudo -v\r\x1b[Kops@esx:~$ ssh other", `\r\n${C}${SUDO}`);
    expect(w.prompt()?.elsewhere).toMatch(/ssh other/);
  });

  it("offers nothing at the shell's own prompt", async () => {
    expect((await fed(`${A}${SUDO}${B}`)).prompt()).toBeNull();
    expect((await fed(`${A}ops@esx:~$ ${B}sudo -v`)).prompt()).toBeNull();
  });

  it("stays unsure for good once a shell with marks starts inside a command", async () => {
    const w = await fed(...marked("bash"), `\r\n${A}$ ${B}ls\r\n${C}${D(0)}${A}$ ${B}sudo -v\r\n${C}${SUDO}`);
    // A shell is something that may reach another machine, too (ticket 120): every fill stops.
    expect(w.prompt()?.elsewhere).toMatch(/shell started inside|aren't roster's own/);
  });

  it("refuses when the command line couldn't be read", async () => {
    const w = await fed(`${A}ops@esx:~$ `, `sudo -v\r\n${C}${SUDO}`);
    expect(w.prompt()?.elsewhere).toMatch(/couldn't read/);
  });
});

describe("sudoOnly", () => {
  it.each(["sudo -v", "sudo -u ops -- make", "A=1 B=2 sudo apt update", "sudo -i", "sudo"])("takes %j", (c) => {
    expect(sudoOnly(c)).toBe(true);
  });
  it.each(["ssh x", "sudo ssh x", "sudo -u x ssh x", "sudo env ssh x", "sudo -v && ssh x", "sudo $(cmd)", "sudo `cmd`", "doas -v", ""])(
    "refuses %j",
    (c) => {
      expect(sudoOnly(c)).toBe(false);
    },
  );
});

// Ticket 120 (decision Q131): a nested ssh to an Inventory Host, read at the outer shell's `C`
// mark. The outer shell runs roster's hook line, so its marks carry the Session's token; marks
// without it are another shell's (the far Host's) or forged.
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
const INVENTORY = [host("esx-01", "10.0.0.11"), host("esx-02", "10.0.0.12"), host("keyed", "10.0.0.30", { enroll: true, ssh: { user: "ops", port: 22, auth: "key" } })];
const TO_ESX_02 = { host: "esx-02", address: "10.0.0.12", port: 22, user: "ops" };
const SSH_PROMPT = "ops@esx-02's password: ";
const N = "0123456789abcdef01234567";
/** The outer shell's own marks: roster's hook line, with this Session's token. */
const oA = `\x1b]133;A;roster=${N}\x07`;
const oB = `\x1b]133;B;roster=${N}\x07`;
const oC = `\x1b]133;C;roster=${N}\x07`;
const oD = (code: number) => `\x1b]133;D;${code};roster=${N}\x07`;
/** The far Host's shell (its own integration, or roster's hook line there with no token of ours). */
const inner = `${A}ops@esx-02:~$ ${B}`;

/** A watch whose Session got roster's hook line before anything was typed, fed `chunks`; Enter
 * is pressed before each chunk that starts the outer shell's C. */
async function hopping(chunks: string[], fill = true): Promise<PromptWatch> {
  const w = new PromptWatch({ cols: 80, rows: 24 }, "ops", { hosts: () => INVENTORY, fill }, N);
  watches.push(w);
  w.hookSent();
  for (const c of chunks) {
    if (c.startsWith(`\r\n${oC}`)) w.typed("\r");
    await w.write(c);
  }
  return w;
}
/** esx-01's own shell runs `command`, which prints `after`. */
const ran = (command: string, after = "") => [`${oA}ops@esx-01:~$ ${oB}`, command, `\r\n${oC}${after}`];
/** That command ends: esx-01's shell says so with its own D and prompt. */
const back = (code = 0) => `\r\n${oD(code)}${oA}ops@esx-01:~$ ${oB}`;

describe("PromptWatch: the Host a nested ssh is on (the breadcrumb)", () => {
  it("shows the Host from the ssh's C until the outer shell's own D", async () => {
    const w = await hopping(ran("ssh esx-02", "Welcome\r\n"));
    expect(w.hop()).toEqual({ to: "esx-02", known: true });
    await w.write(`logout${back()}`);
    expect(w.hop()).toBeNull();
  });

  it("shows an ssh it can't resolve as such", async () => {
    expect((await hopping(ran("ssh -J jump esx-02"))).hop()).toEqual({ to: "esx-02", known: false });
    expect((await hopping(ran("ssh 10.0.0.99"))).hop()).toEqual({ to: "10.0.0.99", known: false });
  });

  it("shows nothing for a command that isn't an ssh, or without marks", async () => {
    expect((await hopping(ran("ls"))).hop()).toBeNull();
    expect((await hopping([`ops@esx-01:~$ ssh esx-02\r\n`])).hop()).toBeNull();
  });

  it.each([
    ["a D before its first prompt (roster's hook, kitty, VS Code)", `${D(0)}${inner}`],
    ["a command ending there", `${inner}ls\r\n${C}a\r\n${D(0)}${inner}`],
    ["`exec bash` there", `${inner}exec bash\r\n${C}${D(0)}${inner}`],
    ["`exit` typed into a nested shell there", `${inner}bash\r\n${C}$ exit\r\n${D(0)}${inner}`],
    ["a forged D with a farewell", `Connection to esx-02 closed.\r\n${D(255)}${A}ops@esx-01:~$ ${B}`],
  ])("isn't ended by the far Host's marks: %s", async (_, there) => {
    const w = await hopping([...ran("ssh esx-02", there)]);
    expect(w.hop()).toEqual({ to: "esx-02", known: true });
  });

  it("ends however the ssh ended, once esx-01's own shell says so", async () => {
    const w = await hopping([...ran("ssh esx-02", `${inner}top\r\n${C}`), `client_loop: send disconnect: Connection reset by peer${back(255)}`]);
    expect(w.hop()).toBeNull();
  });
});

describe("PromptWatch: a nested ssh's password prompt", () => {
  it("offers the Host's own login prompt while its ssh logs in", async () => {
    const w = await hopping(ran("ssh esx-02", `Authorized use only\r\n${SSH_PROMPT}`));
    expect(w.prompt()).toEqual({ line: "ops@esx-02's password:", elsewhere: null, marked: true, kind: "ssh", hop: TO_ESX_02 });
  });

  it.each([
    ["ssh 10.0.0.12", "ops@10.0.0.12's password: "],
    ["ssh ops@ESX-02", SSH_PROMPT],
    ["ssh -l ops -p 22 esx-02", SSH_PROMPT],
  ])("offers it for %j", async (command, asks) => {
    expect((await hopping(ran(command, asks))).prompt()).toMatchObject({ elsewhere: null, hop: TO_ESX_02 });
  });

  it("tries a fill once per ssh: not again after a wrong password, again after roster serve refused (nothing typed)", async () => {
    const w = await hopping(ran("ssh esx-02", SSH_PROMPT));
    w.spent();
    expect(w.prompt()).toBeNull();
    await w.write(`\r\nPermission denied, please try again.\r\n${SSH_PROMPT}`);
    expect(w.prompt()?.elsewhere).toMatch(/already tried/);
    w.unspent();
    expect(w.prompt()?.elsewhere).toBeNull();
  });

  it.each([
    ["ssh esx-02", "root@esx-02's password: ", /root@esx-02/],
    ["ssh esx-02", "ops@10.0.0.12's password: ", /ops@10\.0\.0\.12/],
    ["ssh esx-02", "ops@esx-01's password: ", /esx-01/],
    ["ssh root@esx-02", "root@esx-02's password: ", /root/],
    ["ssh keyed", "ops@keyed's password: ", /key/],
    ["ssh -J jump esx-02", SSH_PROMPT, /can't tell where.*-J/],
    ["ssh -o ProxyCommand=nc esx-02", SSH_PROMPT, /ProxyCommand/],
    ["ssh 10.0.0.99", "ops@10.0.0.99's password: ", /isn't a Host/],
  ])("refuses %j at %j", async (command, asks, why) => {
    const w = await hopping(ran(command, asks));
    expect(w.prompt()).toMatchObject({ kind: "ssh", hop: null, elsewhere: expect.stringMatching(why) });
  });

  it("refuses once you've typed into the ssh (a host-key question answered, a command run there)", async () => {
    const w = await hopping(ran("ssh esx-02", "Are you sure you want to continue connecting (yes/no/[fingerprint])? "));
    w.typed("yes\r");
    await w.write(`yes\r\nWarning: Permanently added 'esx-02' to the list of known hosts.\r\n${SSH_PROMPT}`);
    expect(w.prompt()?.elsewhere).toMatch(/typed/);
  });

  it("refuses once a shell has started on the Host", async () => {
    const w = await hopping(ran("ssh esx-02", inner));
    await w.write(`\r\n${SSH_PROMPT}`);
    expect(w.prompt()?.elsewhere).toMatch(/shell has started/);
  });

  it("refuses once the ssh has printed more than its login's lines after the prompt", async () => {
    const w = await hopping(ran("ssh esx-02", `${SSH_PROMPT}\r\nLast login: today\r\n${SSH_PROMPT}`));
    expect(w.prompt()?.elsewhere).toMatch(/printed more/);
  });

  it("doesn't take a line the Host drew by itself, with no Enter from you, for an ssh you ran", async () => {
    const w = new PromptWatch({ cols: 80, rows: 24 }, "ops", { hosts: () => INVENTORY, fill: true }, N);
    watches.push(w);
    w.hookSent();
    for (const c of ran("ssh esx-02", SSH_PROMPT)) await w.write(c);
    expect(w.hop()).toEqual({ to: "esx-02", known: false });
    expect(w.prompt()?.elsewhere).toMatch(/press Enter/);
  });

  it("says a roster serve too old to fill another Host's prompt is why", async () => {
    expect((await hopping(ran("ssh esx-02", SSH_PROMPT), false)).prompt()?.elsewhere).toMatch(/newer roster/);
  });

  it("without marks, says it can't tell where the ssh went, and offers nothing", async () => {
    const w = await hopping([`ops@esx-01:~$ ssh esx-02\r\n${SSH_PROMPT}`]);
    expect(w.prompt()).toMatchObject({ kind: "ssh", marked: false, hop: null, elsewhere: expect.stringMatching(/marks/) });
  });
});

describe("PromptWatch: sudo on the Host a nested ssh is on", () => {
  const SUDO_THERE = (command: string, user = "ops") => `${command}\r\n${C}[sudo] password for ${user}: `;

  it("offers that Host's sudo at the first command its marked shell runs", async () => {
    const w = await hopping([...ran("ssh esx-02", inner), SUDO_THERE("sudo -v")]);
    expect(w.prompt()).toEqual({ line: "[sudo] password for ops:", elsewhere: null, marked: true, kind: "sudo", hop: TO_ESX_02 });
  });

  it("never takes the far shell for esx-01's when it marks a D before its first prompt (the leak)", async () => {
    // roster's own hook, kitty and VS Code print D before the first A: it's still esx-02's shell.
    const w = await hopping([...ran("ssh esx-02", `${D(0)}${inner}`), SUDO_THERE("sudo -v")]);
    expect(w.hop()).toEqual({ to: "esx-02", known: true });
    expect(w.prompt()).toMatchObject({ kind: "sudo", hop: TO_ESX_02 });
  });

  it("refuses once a command there has ended", async () => {
    const w = await hopping([...ran("ssh esx-02", inner), `ls\r\n${C}a\r\n${D(0)}${inner}`, SUDO_THERE("sudo -v")]);
    expect(w.prompt()).toMatchObject({ hop: null, elsewhere: expect.stringMatching(/a command ended/) });
  });

  it("refuses when the shell there doesn't mark its commands", async () => {
    const w = await hopping(ran("ssh esx-02", `ops@esx-02:~$ sudo -v\r\n${SUDO}`));
    expect(w.prompt()).toMatchObject({ hop: null, elsewhere: expect.stringMatching(/doesn't mark/) });
  });

  it.each([
    ["ssh esx-02", "sudo ssh other", "ops", /ssh other/],
    ["ssh root@esx-02", "sudo -v", "root", /root/],
    ["ssh -J jump esx-02", "sudo -v", "ops", /`ssh -J jump esx-02` is running/],
  ])("refuses after %j, running %j there", async (command, there, user, why) => {
    const w = await hopping([...ran(command, inner), SUDO_THERE(there, user)]);
    expect(w.prompt()).toMatchObject({ hop: null, elsewhere: expect.stringMatching(why) });
  });

  it("offers nothing at the shell's own prompt there", async () => {
    expect((await hopping([...ran("ssh esx-02", inner), "sudo -v"])).prompt()).toBeNull();
  });

  it("offers esx-01's own sudo again once its own D says the ssh ended", async () => {
    const w = await hopping([...ran("ssh esx-02", `${inner}exit\r\n${C}logout`), back(), "sudo -v", `\r\n${oC}${SUDO}`]);
    expect(w.hop()).toBeNull();
    expect(w.prompt()).toEqual({ line: "[sudo] password for ops:", elsewhere: null, marked: true, kind: "sudo", hop: null });
  });

  it("refuses esx-01's own sudo while a command it runs has started a marked shell", async () => {
    const w = await hopping([...ran("sudo -i", `${A}root# ${B}`), `\r\n${SUDO}`]);
    expect(w.prompt()?.elsewhere).toMatch(/shell started inside/);
  });
});

describe("PromptWatch: a Session whose marks aren't roster's own (fail closed)", () => {
  // The shell's own integration (no token): once something that may reach another machine runs,
  // roster can't tell which shell any later mark is, so it fills nothing more in this Session.
  it.each(["ssh esx-02", "mosh esx-02", "docker exec -it web sh", "kubectl exec -it pod -- sh", "eval $X", "a $(b)"])(
    "refuses every fill once %j has run, esx-01's own sudo included, and says how to fix it",
    async (command) => {
      const w = await fed(...marked(command), `\r\nlogout\r\n${D(0)}`, ...marked("sudo -v"));
      expect(w.prompt()?.elsewhere).toMatch(/aren't roster's own.*shell hooks/);
      expect(w.hop()).toBeNull();
    },
  );

  it("still offers sudo before anything that may reach another machine has run", async () => {
    const w = await fed(...marked("ls"), `\r\n${D(0)}`, ...marked("sudo -v"));
    expect(w.prompt()?.elsewhere).toBeNull();
  });

  it("doesn't take roster's token from a hook line sent after you typed for proof", async () => {
    const w = new PromptWatch({ cols: 80, rows: 24 }, "ops", { hosts: () => INVENTORY, fill: true }, N);
    watches.push(w);
    w.typed("ssh esx-02\r");
    w.hookSent(); // :integrate, typed after the ssh: it may have gone to esx-02's shell
    for (const c of ran("ssh esx-02", SSH_PROMPT)) await w.write(c);
    expect(w.hop()).toBeNull();
    expect(w.prompt()?.elsewhere).toMatch(/aren't roster's own/);
  });
});

describe("mayReachElsewhere: what stops every fill when the marks aren't roster's (best effort)", () => {
  it.each([
    "cu -l /dev/ttyUSB0", "minicom -D /dev/ttyS0", "picocom /dev/ttyUSB0", "screen /dev/ttyUSB0 115200", "tmux attach",
    "console fw01", "ipmitool -I lanplus -H 10.0.0.9 sol activate", "aws ssm start-session --target i-0abc",
    "gcloud compute ssh vm-1", "az ssh vm -n vm-1", "virsh console vm1", "lxc exec c1 -- bash", "incus exec c1 bash",
    "podman exec -it c sh", "nerdctl exec -it c sh", "nsenter -t 1 -a", "chroot /mnt", "bash", "su -", "sudo -i",
    "sudo -s", "sudo su -", "doas sh", "ssh esx-02", "a $(b)", "eval $X",
  ])("%j", (command) => {
    expect(mayReachElsewhere(command)).toBe(true);
  });

  it.each(["ls -l", "sudo -v", "sudo apt upgrade", "aws s3 ls", "gcloud config list", "cat /etc/hosts", "make deploy"])(
    "not %j",
    (command) => {
      expect(mayReachElsewhere(command)).toBe(false);
    },
  );
});
