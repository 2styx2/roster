// How a Session ended, in docs/app/errors.md's terms. ssh writes its errors into the PTY, so all the
// app has is the terminal output's last lines and the exit code; roster's askpass helper adds one
// line of its own (`roster askpass: [CODE] REASON`). classifyExit turns those into a Problem: a
// catalog code (roster's numbers, so a Session error and `:check` share one table), a plain
// message naming the Host, the fix, and the raw text for Details. The wording follows roster's
// own (roster/src/roster/diagnose.py `login_failure`), which does the same for `host.check`.
// Nothing here ever sees a password: ssh reads it from askpass, it never reaches the terminal.
import { Code } from "../backend/serveContract";

/** roster's error codes (docs/serve-api.md), plus the app's own for what only the
 * Session sees: a dropped connection, a Host that hung up before the login, and a lost `serve`. */
export type ProblemCode = number | "dropped" | "closed-early" | "backend-lost";

/** What a code's row may need beyond the message: names for 32, matches for 33, fingerprints
 * for 43 (from `host.check`, or what ssh printed). Never a secret. */
export interface ProblemData {
  near?: string[];
  matches?: { name: string; revised?: string | null; uris?: string[] }[];
  /** 43: the fingerprints roster recorded (host.check) and the one the Host offers. */
  recorded?: string[];
  offered?: string | null;
  /** 43 from ssh's output: the known_hosts line holding the recorded key. */
  recordedAt?: string;
  /** 1: the roster.yml path and line. */
  path?: string | null;
  line?: number;
  provider?: string;
  field?: string;
  [key: string]: unknown;
}

/** A clean error (docs/app/errors.md): the code picks the catalog row (where it lives, what to do). */
export interface Problem {
  code: ProblemCode;
  host: string;
  /** Plain words, naming the Host. */
  message: string;
  /** The fix in a sentence, when there's a specific one (else the row's). */
  fix?: string;
  /** The raw text: ssh's last lines, or roster's message. */
  details: string;
  data?: ProblemData;
  /** A Quick Connect's (ticket 14): `host` is user@address, not a Host, so fixes that name a Host
   * (`:check`, `roster setup --host`) don't apply. */
  quick?: boolean;
}

export interface ExitInput {
  /** ssh's exit code (255: it couldn't connect or log in); null when a signal ended it. */
  exitCode: number | null;
  /** The terminal's last lines, as plain text (see terminalTail). */
  tail: string;
  /** roster's askpass line, if it came separately; otherwise it's looked for in `tail`. */
  askpassLine?: string;
  host: string;
  /** How the Session logs in, once known: tells a refused password from a refused key. */
  auth?: "key" | "password" | null;
}

/** `roster askpass: [CODE] REASON` (docs/serve-api.md). */
const ASKPASS_LINE = /^roster askpass: \[(\d+)\] (.*)$/;

const ESC = "\x1b";
/** OSC (titles, links) up to BEL or ST. */
const OSC = new RegExp(`${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`, "g");
/** CSI cursor positioning (ConPTY draws lines this way rather than with newlines). */
const CUP = new RegExp(`${ESC}\\[\\d*(?:;\\d*)?[Hf]`, "g");
/** Every other CSI sequence, and two-character escapes. */
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]|${ESC}[()][0-9A-Za-z]`, "g");

/** What's left of an OSC whose start the tail cut off: a payload-shaped run at its very start
 * (OSC 52's `Pc;` and base64, 16 characters at least, nothing else) up to a BEL or ST. A shell's
 * bell after a prompt or a word isn't one. And one cut off at the end: from its `ESC ]` on. */
const CUT_OSC_START = new RegExp(`^(?:\\d*;)?(?:[cpqs0-7]*;)?[A-Za-z0-9+/]{16,}={0,2}(?:\\x07|${ESC}\\\\)`);
const CUT_OSC_END = new RegExp(`${ESC}\\][^\\x07${ESC}]*$`);
/** A long base64-looking run (an encoded payload, a copied blob): never worth showing in a
 * Problem, and it may be copied text (#295 review). A host key fingerprint (43) is shorter. */
const BASE64_RUN = /[A-Za-z0-9+/]{64,}={0,2}/g;

/** The last `lines` non-empty lines of terminal output as plain text: escape sequences gone, a
 * carriage return keeping what was written after it. `strippedAtCapture`: OSC 52 was taken out
 * as the output came (tabs.ts `preAuth` and `late`), so a cut-off one isn't looked for. */
export function terminalTail(output: string, lines = 30, { strippedAtCapture = false }: { strippedAtCapture?: boolean } = {}): string {
  const plain = output
    .replace(OSC, "")
    // Output stripped of OSC 52 as it came (tabs.ts) has no cut-off payload to find.
    .replace(strippedAtCapture ? /(?!)/ : CUT_OSC_START, "")
    .replace(CUT_OSC_END, "")
    .replace(BASE64_RUN, "")
    .replace(CUP, "\n")
    .replace(CSI, "")
    // eslint-disable-next-line no-control-regex -- stripping the remaining control characters
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const out = plain
    .split("\n")
    .map((l) => {
      const parts = l.split("\r").filter((p) => p.length > 0);
      return (parts.at(-1) ?? "").trimEnd();
    })
    .filter((l) => l.trim().length > 0);
  return out.slice(-lines).join("\n");
}

/** Row 17's fix. Which networks have an SSH rate limiter is roster.yml's `rate_limited:` (#363), which the app
 * never reads (ADR 0001), so a Session's no-answer gets the generic hint; `:check HOST` (serve) names the network. */
const UNREACHABLE_FIX =
  "Retry later: is the Host up, and the network path open? If not, a rate limiter on the network can cause this: wait a few minutes, don't retry in a loop.";

/** ssh's own lines when an open Session's connection goes away (row 20). */
function dropped(lines: string[], host: string): Omit<Problem, "host" | "details"> | null {
  if (find(lines, /Timeout, server \S+ not responding/)) {
    return { code: "dropped", message: `${host} stopped answering, so ssh ended the Session` };
  }
  if (find(lines, /Connection to \S+ closed by remote host/)) {
    return { code: "dropped", message: `The connection was closed by the Host (${host})` };
  }
  if (find(lines, /Connection reset by peer|Broken pipe/)) {
    return { code: "dropped", message: `Session ended (code 255): connection reset` };
  }
  return null;
}

type Rule = (lines: string[], input: ExitInput, details: string) => Omit<Problem, "host" | "details"> | null;

const find = (lines: string[], re: RegExp) => {
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m;
  }
  return null;
};

/** Ordered: the first that matches wins. Host keys come before askpass (askpass refuses the
 * yes/no prompt, but the problem is the unknown key), askpass before ssh's own "Permission denied". */
const rules: Rule[] = [
  (lines, { host }) => {
    if (!find(lines, /REMOTE HOST IDENTIFICATION HAS CHANGED/)) return null;
    const i = lines.findIndex((l) => /^The fingerprint for the \S+ key sent by the remote host is/.test(l));
    const offered = i >= 0 ? (lines[i + 1] ?? "").trim().replace(/\.$/, "") : null;
    const at = find(lines, /^Offending \S+ key in (\S+)$/)?.[1];
    return {
      code: Code.HOST_KEY_CHANGED,
      message: `${host}'s host key changed. Not connecting.`,
      data: { offered, ...(at ? { recordedAt: at } : {}) },
    };
  },
  (lines, { host }) => {
    const unknown = find(lines, /^No \S+ host key is known for /) ?? find(lines, /^The authenticity of host .* can't be established/);
    if (!unknown && !(find(lines, /^Host key verification failed/) && !find(lines, ASKPASS_LINE))) return null;
    const offered = find(lines, /key fingerprint is (SHA256:[^\s.]+)/)?.[1] ?? null;
    return { code: Code.HOST_KEY_UNKNOWN, message: `No recorded host key for ${host}`, ...(offered ? { data: { offered } } : {}) };
  },
  (lines, input) => {
    const line = input.askpassLine ?? find(lines, ASKPASS_LINE)?.[0];
    const m = line ? ASKPASS_LINE.exec(line.trim()) : null;
    if (!m) return null;
    return { code: Number(m[1]), message: m[2] ?? "" };
  },
  (lines) => {
    const m = find(lines, /^ssh: Could not resolve hostname (.+?): (.*)$/);
    return m ? { code: Code.NO_DNS, message: `Can't resolve '${m[1]}'` } : null;
  },
  (lines, { host }) => {
    const m = find(lines, /^ssh: connect to host (\S+) port (\d+): (.*)$/);
    if (!m) return null;
    const where = `${host} (${m[1]}:${m[2]})`;
    if (/refused/i.test(m[3] ?? "")) {
      return {
        code: Code.REFUSED,
        message: `${where} refused the connection`,
        fix: "Check the port in roster.yml; is sshd running on the Host?",
      };
    }
    return { code: Code.TIMEOUT, message: `${where} didn't answer`, fix: UNREACHABLE_FIX };
  },
  (lines, { host }) => {
    const m = find(lines, /^Connection to (\S+) port (\d+) timed out/);
    if (!m && !find(lines, /^Connection timed out during banner exchange/)) return null;
    const where = m ? `${host} (${m[1]}:${m[2]})` : host;
    return { code: Code.TIMEOUT, message: `${where} didn't answer`, fix: UNREACHABLE_FIX };
  },
  (lines, { host }) => {
    if (!find(lines, /Too many authentication failures/)) return null;
    return { code: Code.TOO_MANY_AUTH, message: `${host} cut the connection after too many key attempts` };
  },
  (lines, { host, auth }) => {
    // ssh's own line is `user@host: Permission denied (methods).`; a command's output isn't.
    const m = find(lines, /^(?:(\S+?)@\S+: )?Permission denied \(([^)]*)\)\.?$/);
    if (!m) return null;
    const user = m[1];
    if (auth === "password") {
      return { code: Code.PASSWORD_REFUSED, message: `${host} refused the password${user ? ` for user ${user}` : ""}` };
    }
    return { code: Code.KEY_REFUSED, message: `${host} didn't accept this Box's key${user ? ` for user ${user}` : ""}` };
  },
  (lines, { host }) => {
    const m = find(lines, /^kex_exchange_identification: (.*)$/);
    if (!m) return null;
    return {
      code: "closed-early",
      message: `${host} hung up before logging in (${m[1]})`,
      fix: UNREACHABLE_FIX,
    };
  },
  (lines, { host }) => {
    const m = find(lines, /^Unable to negotiate with (\S+) port \d+: (.*)$/);
    if (!m) return null;
    return {
      code: Code.AUTH_FAILED,
      message: `ssh and ${host} couldn't agree on how to talk: ${m[2]}`,
      fix: "The Host is old; its algorithms need allowing in roster's ssh config for it (roster-side).",
    };
  },
  (lines, input) => dropped(lines, input.host),
];

/** The Problem behind an ended Session, or null when it ended normally (the shell exited with
 * its own code, or a signal ended it). ssh's own failures exit 255. */
export function classifyExit(input: ExitInput): Problem | null {
  if (input.exitCode !== 255) return null;
  const details = [input.askpassLine, input.tail].filter(Boolean).join("\n");
  const lines = input.tail.split(/\r?\n/).map((l) => l.trim());
  for (const rule of rules) {
    const found = rule(lines, input, details);
    if (found) return { host: input.host, details, ...found };
  }
  return {
    code: Code.AUTH_FAILED,
    host: input.host,
    message: `ssh couldn't open the Session to ${input.host} (code 255)`,
    fix: "See the details: ssh's own message.",
    details: details || "ssh ended with code 255 and no message",
  };
}

/** How a Session that had logged in ended with 255: always row 20 ("dropped"). Its output is the
 * Host's by then, so a nested ssh's error or a `roster askpass:` line printed there says nothing
 * about this Session; only ssh's own drop lines pick a more specific message. */
export function classifyDrop({ host, tail }: { host: string; tail: string }): Problem {
  const lines = tail.split(/\r?\n/).map((l) => l.trim());
  const found = dropped(lines, host) ?? { code: "dropped" as const, message: `The Session to ${host} ended (code 255)` };
  return { host, details: tail || "ssh ended with code 255 and no message", ...found };
}
