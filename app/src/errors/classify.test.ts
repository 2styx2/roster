// classifyExit against real OpenSSH 9/10 stderr, as it lands in the PTY (CRLF line ends), and
// roster's askpass lines. Expected codes are docs/app/errors.md's rows, in roster's code numbers.
import { describe, expect, it } from "vitest";
import { classifyExit, terminalTail, type ProblemCode } from "./classify";

const CHANGED = [
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
  "Someone could be eavesdropping on you right now (man-in-the-middle attack)!",
  "It is also possible that a host key has just been changed.",
  "The fingerprint for the ED25519 key sent by the remote host is",
  "SHA256:mX0xg1jn8T8p0bq2Wl3c7c4pQe0b7aR6E2wV8iY0fUk.",
  "Please contact your system administrator.",
  "Add correct host key in ~/.ssh/roster_known_hosts to get rid of this message.",
  "Offending ED25519 key in ~/.ssh/roster_known_hosts:12",
  "Host key for esx has changed and you have requested strict checking.",
  "Host key verification failed.",
].join("\r\n");

/** [what, exit code, ssh's output, auth, expected code, a bit of the message]. */
const samples: [string, number, string, "key" | "password", ProblemCode, RegExp][] = [
  ["DNS (glibc)", 255, "ssh: Could not resolve hostname esxi02.lab: Name or service not known\r\n", "key", 40, /resolve 'esxi02\.lab'/],
  ["DNS (no resolver)", 255, "ssh: Could not resolve hostname nope.invalid: Temporary failure in name resolution\r\n", "key", 40, /resolve/],
  ["refused", 255, "ssh: connect to host 10.0.0.6 port 2222: Connection refused\r\n", "key", 41, /10\.0\.0\.6:2222\) refused/],
  ["timeout", 255, "ssh: connect to host 10.19.77.5 port 22: Connection timed out\r\n", "key", 42, /didn't answer/],
  ["no route", 255, "ssh: connect to host 10.9.9.9 port 22: No route to host\r\n", "key", 42, /didn't answer|reach/],
  ["banner timeout", 255, "Connection timed out during banner exchange\r\nConnection to 10.19.77.5 port 22 timed out\r\n", "key", 42, /didn't answer/],
  ["host key changed", 255, CHANGED, "key", 43, /host key changed/],
  ["host key unknown", 255, "No ED25519 host key is known for esx and you have requested strict checking.\r\nHost key verification failed.\r\n", "key", 44, /No recorded host key/],
  [
    "unknown key, askpass refused the yes/no",
    255,
    "The authenticity of host 'esx (10.0.0.6)' can't be established.\r\nED25519 key fingerprint is SHA256:abcDEF123.\r\nThis key is not known by any other names.\r\nroster askpass: [36] esx asked something roster won't answer: 'Are you sure you want to continue connecting (yes/no/[fingerprint])?' - log in by hand once to deal with it\r\nHost key verification failed.\r\n",
    "password",
    44,
    /No recorded host key/,
  ],
  ["password refused", 255, "root@esx: Permission denied (publickey,password).\r\n", "password", 45, /refused the password for user root/],
  ["password refused, retry wording", 255, "Permission denied, please try again.\r\nroot@esx: Permission denied (publickey,password,keyboard-interactive).\r\n", "password", 45, /password/],
  ["key refused", 255, "admin@esx: Permission denied (publickey).\r\n", "key", 46, /didn't accept this Box's key/],
  ["key refused, gssapi", 255, "admin@esx: Permission denied (publickey,gssapi-keyex,gssapi-with-mic,password).\r\n", "key", 46, /key/],
  ["too many auth", 255, "Received disconnect from 10.0.0.6 port 22:2: Too many authentication failures\r\nDisconnected from 10.0.0.6 port 22\r\n", "password", 47, /too many key attempts/],
  ["reset (client_loop)", 255, "admin@esx:~$ \r\nclient_loop: send disconnect: Connection reset by peer\r\n", "key", "dropped", /connection reset/i],
  ["closed by remote", 255, "admin@esx:~$ Connection to 10.0.0.6 closed by remote host.\r\nConnection to 10.0.0.6 closed.\r\n", "key", "dropped", /closed by the Host/],
  ["server alive timeout", 255, "Timeout, server 10.0.0.6 not responding.\r\n", "key", "dropped", /stopped answering/],
  ["broken pipe", 255, "packet_write_wait: Connection to 10.0.0.6 port 22: Broken pipe\r\n", "key", "dropped", /connection/i],
  ["kex reset", 255, "kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 10.19.77.5 port 22\r\n", "key", "closed-early", /before logging in/],
  ["kex closed", 255, "kex_exchange_identification: Connection closed by remote host\r\nConnection closed by 10.0.0.6 port 22\r\n", "key", "closed-early", /before logging in/],
  ["no common host key type", 255, "Unable to negotiate with 10.0.0.9 port 22: no matching host key type found. Their offer: ssh-rsa,ssh-dss\r\n", "key", 48, /agree on/],
  ["askpass: no item", 255, "roster askpass: [32] no vault item named 'esx shh' (ssh Login of esx) - did you mean: 'esx ssh'\r\nroot@esx: Permission denied (publickey,password).\r\n", "password", 32, /^no vault item named 'esx shh'/],
  ["askpass: odd prompt", 255, "roster askpass: [36] esx asked something roster won't answer: 'New password:' - log in by hand once to deal with it\r\nroot@esx: Permission denied (publickey,password).\r\n", "password", 36, /New password/],
  ["askpass: token spent", 255, "roster askpass: [37] the askpass token is used up, expired or cleared by a lock - open the Session again\r\nroot@esx: Permission denied (password).\r\n", "password", 37, /token/],
  ["askpass: no serve", 255, "roster askpass: [38] can't reach roster serve (Connection refused)\r\nroot@esx: Permission denied (password).\r\n", "password", 38, /can't reach roster serve/],
  ["something else", 255, "Bad owner or permissions on ~/.ssh/config\r\n", "key", 48, /ssh couldn't/],
];

describe("classifyExit", () => {
  it.each(samples)("%s", (_what, exitCode, output, auth, code, message) => {
    const p = classifyExit({ exitCode, tail: terminalTail(output), host: "esx", auth });
    expect(p?.code).toBe(code);
    expect(p?.message).toMatch(message);
    expect(p?.details).toContain(output.split("\r\n").find((l) => l.trim())?.trim() ?? "");
  });

  it("is not an error when the shell exited by itself, or the app closed it", () => {
    expect(classifyExit({ exitCode: 0, tail: "logout\nConnection to esx closed.", host: "esx" })).toBeNull();
    expect(classifyExit({ exitCode: 1, tail: "bash: foo: command not found", host: "esx" })).toBeNull();
    expect(classifyExit({ exitCode: null, tail: "", host: "esx" })).toBeNull();
  });

  it("takes the askpass line given separately over one in the tail", () => {
    const p = classifyExit({
      exitCode: 255,
      tail: "root@esx: Permission denied (password).",
      askpassLine: "roster askpass: [34] vault item 'esx ssh' has no password (ssh Login of esx)",
      host: "esx",
      auth: "password",
    });
    expect(p?.code).toBe(34);
  });

  it("ignores a 'Permission denied' the user's own commands printed in the Session", () => {
    const tail = "admin@esx:~$ cat /etc/shadow\r\ncat: /etc/shadow: Permission denied\r\nclient_loop: send disconnect: Connection reset by peer\r\n";
    expect(classifyExit({ exitCode: 255, tail: terminalTail(tail), host: "esx", auth: "key" })?.code).toBe("dropped");
  });

  it("keeps both fingerprints' sources for a changed host key: the offered one and the recorded line", () => {
    const p = classifyExit({ exitCode: 255, tail: terminalTail(CHANGED), host: "esx", auth: "key" });
    expect(p?.data).toMatchObject({
      offered: "SHA256:mX0xg1jn8T8p0bq2Wl3c7c4pQe0b7aR6E2wV8iY0fUk",
      recordedAt: "~/.ssh/roster_known_hosts:12",
    });
  });

  it("names the address and port it couldn't reach, and the 10.19 rate limiter when it applies", () => {
    const p = classifyExit({
      exitCode: 255,
      tail: "ssh: connect to host 10.19.77.5 port 22: Connection timed out",
      host: "esxi-02",
      auth: "key",
    });
    expect(p?.message).toBe("esxi-02 (10.19.77.5:22) didn't answer");
    expect(p?.fix).toMatch(/rate limiter/);
    const q = classifyExit({ exitCode: 255, tail: "ssh: connect to host 10.1.1.1 port 22: Connection timed out", host: "x" });
    expect(q?.fix).not.toMatch(/rate limiter/);
  });
});

describe("terminalTail", () => {
  it("strips colours, cursor moves and titles, and keeps the last lines", () => {
    const raw = "\x1b]0;esx\x07\x1b[1;31mred\x1b[0m\r\n\x1b[?25lone\x1b[K\r\n" + "x\r\n".repeat(100) + "last";
    const tail = terminalTail(raw, 5);
    expect(tail.split("\n")).toEqual(["x", "x", "x", "x", "last"]);
    expect(terminalTail("\x1b[1;31mred\x1b[0m\r\nok")).toBe("red\nok");
  });

  it("turns ConPTY's cursor positioning into line breaks", () => {
    expect(terminalTail("\x1b[2J\x1b[Hssh: one\x1b[2;1Htwo\x1b[3;1H")).toBe("ssh: one\ntwo");
  });

  it("keeps what a carriage return overwrote last", () => {
    expect(terminalTail("Password: \rroster askpass: [37] spent")).toBe("roster askpass: [37] spent");
  });
});

describe("terminalTail drops what's left of an escape sequence cut off at its start (#295 review)", () => {
  it("drops the body of an OSC whose start was cut off, up to its BEL or ST", () => {
    expect(terminalTail("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\x07Timeout, server 10.0.0.6 not responding.")).toBe(
      "Timeout, server 10.0.0.6 not responding.",
    );
    expect(terminalTail("QUJDREVG\x1b\\done")).toBe("done");
  });

  it("keeps the text before a whole OSC", () => {
    expect(terminalTail("before\x1b]0;title\x07after")).toBe("beforeafter");
  });

  it("drops a long base64-looking run", () => {
    const run = "QUJD".repeat(40);
    expect(terminalTail(`x ${run} y`)).not.toContain(run.slice(0, 64));
    // A host key fingerprint (43 characters) stays.
    const fp = "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8";
    expect(terminalTail(fp)).toBe(fp);
  });
});
