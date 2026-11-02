// Where a nested `ssh` goes (ticket 120, decision Q131), from the command line the shell's `C`
// mark says it ran (prompt.ts reads it off the screen). Pure: no terminal, no Backend.
//
// The rule is Q129's: refuse whenever in doubt. ssh's options are read as ssh reads them (its
// flags with and without a value, clustered or not, options after the destination, `--`, the last
// `@` splitting user from host); anything that may send the connection somewhere roster can't see
// is refused: a jump host, a proxy command, a config file, a mux socket, an option that changes
// how the host key is checked, a wildcard, a quote or `$` (the shell would rewrite the word), shell
// syntax. What isn't refused is matched against the Inventory by name or address and by port; no
// match, or more than one, is no Host.
//
// What roster can't see, and the decision says out loud: the first Host's own ssh config and DNS
// (a name may resolve differently there, or a config may set a port). ssh's prompt names the user
// and the host it really uses (a config's HostName shows), and ssh's host-key check on that Host
// is what ties the name to a box; roster never answers a host-key question.
import { NO_PASSWORD_AUTHS, type Host } from "../backend/types";
import { SHELL_SYNTAX, base, programAt, words as splitWords } from "./commandLine";

export type SshCommand =
  | { ok: true; destination: string; user: string | null; port: number | null; hostName: string | null }
  | { ok: false; why: string; destination: string | null };

/** ssh's flags that take no value. */
const NO_VALUE = new Set("46AaCgKkMNnqsTtvXxYy");
/** ssh's flags that take one (the next word, or the rest of this one). */
const VALUE = new Set("BbcDEeIiLlmopRw");
/** Flags that may send the connection somewhere roster can't see, or don't connect at all. */
const REFUSED: Record<string, string> = {
  J: "-J (a jump host) goes through another machine first",
  F: "-F reads an ssh config roster can't see",
  S: "-S may reuse a connection to another machine",
  W: "-W forwards to another machine",
  f: "-f puts ssh in the background",
  G: "-G only prints ssh's config",
  V: "-V only prints ssh's version",
  Q: "-Q only asks ssh what it supports",
  O: "-O sends a command to another ssh",
  P: "-P picks config roster can't see",
};
/** `-o` options that don't change where ssh connects or how it checks the host. */
const HARMLESS_OPTIONS = new Set([
  "connecttimeout", "serveraliveinterval", "serveralivecountmax", "compression", "tcpkeepalive", "forwardagent",
  "forwardx11", "requesttty", "loglevel", "identityfile", "identitiesonly", "preferredauthentications",
  "pubkeyauthentication", "passwordauthentication", "numberofpasswordprompts", "addkeystoagent",
]); // prettier-ignore

/** Flags that take a value, the refused ones included: to find the destination of a refused line. */
const ANY_VALUE = new Set("BbcDEeIiLlmopRwJFSWPOQ");

/** The destination of a line roster refuses, for the breadcrumb only: the first word that isn't a
 * flag or a flag's value. */
function destinationOf(words: readonly string[], from: number): string | null {
  for (let i = from; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--") return words[i + 1]?.split("@").pop() || null;
    if (!word.startsWith("-") || word.length === 1) return word.split("@").pop() || null;
    const last = word.length - 1;
    for (let j = 1; j <= last; j++) {
      if (ANY_VALUE.has(word[j] ?? "")) {
        if (j === last) i++;
        break;
      }
    }
  }
  return null;
}

/** `command` read as ssh reads its arguments: null when it isn't an ssh at all (after any
 * `VAR=value`); refused, with why, when roster can't be sure where it connects. */
export function parseSsh(command: string): SshCommand | null {
  const words = splitWords(command);
  let i = programAt(words);
  if (base(words[i] ?? "") !== "ssh") return null;
  i++;
  const first = i;
  const refuse = (why: string, destination: string | null = null): SshCommand => ({
    ok: false,
    why,
    destination: destination ?? destinationOf(words, first),
  });
  if (SHELL_SYNTAX.test(command)) return refuse("it has shell syntax roster doesn't follow");
  let destination: string | null = null;
  let user: string | null = null;
  const users = new Set<string>();
  const ports = new Set<number>();
  let hostName: string | null = null;
  let options = true;
  for (; i < words.length; i++) {
    const word = words[i] ?? "";
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.startsWith("-") && word.length > 1) {
      // A cluster of flags; one that takes a value ends it, with the rest or the next word.
      for (let j = 1; j < word.length; j++) {
        const flag = word[j] ?? "";
        const refused = REFUSED[flag];
        if (refused) return refuse(refused, destination);
        if (NO_VALUE.has(flag)) continue;
        if (!VALUE.has(flag)) return refuse(`roster doesn't know ssh's -${flag}`, destination);
        let value = word.slice(j + 1);
        if (!value) {
          i++;
          if (i >= words.length) return refuse(`-${flag} needs a value`, destination);
          value = words[i] ?? "";
        }
        if (/['"\\$]/.test(value)) return refuse("a quote, `\\` or `$` in it changes what ssh is given", destination);
        if (flag === "l") users.add(value);
        else if (flag === "p") {
          const port = portOf(value);
          if (port === null) return refuse(`${value} isn't a port`, destination);
          ports.add(port);
        } else if (flag === "o") {
          const m = /^([A-Za-z]+)=(.*)$/.exec(value);
          if (!m) return refuse(`roster can't read -o ${value}`, destination);
          const [, key = "", v = ""] = m;
          const name = key.toLowerCase();
          if (name === "user") users.add(v);
          else if (name === "port") {
            const port = portOf(v);
            if (port === null) return refuse(`${v} isn't a port`, destination);
            ports.add(port);
          } else if (name === "hostname") {
            if (v.includes("%")) return refuse("HostName with a % token is ssh config roster can't expand", destination);
            if (hostName !== null && hostName !== v) return refuse("it names two HostNames", destination);
            hostName = v;
          } else if (!HARMLESS_OPTIONS.has(name)) {
            return refuse(`-o ${key} may change where ssh connects or how it checks the Host`, destination);
          }
        }
        break;
      }
      continue;
    }
    if (destination !== null) break; // the remote command: ssh reads no options in it
    if (/['"\\]/.test(word)) return refuse("a quote or `\\` in it changes what ssh is given");
    if (word.includes("$")) return refuse("`$` in it is the shell's to expand");
    if (word.startsWith("ssh://")) return refuse("roster doesn't read ssh:// destinations");
    if (/[*?[\]!]/.test(word)) return refuse(`${word} has a wildcard`);
    const at = word.lastIndexOf("@");
    const host = at >= 0 ? word.slice(at + 1) : word;
    if (at === 0 || !host) return refuse(`${word} has no user or no host`);
    if (host.includes("%")) return refuse(`${host} has a % token`);
    if (at > 0) user = word.slice(0, at);
    destination = host;
    // Only after the destination may ssh read more options; once a word isn't one, it's the command.
  }
  if (destination === null) return refuse("it has no destination");
  if (user !== null) users.add(user);
  if (users.size > 1) return refuse("it names two users, and ssh versions differ on which wins", destination);
  if (ports.size > 1) return refuse("it names two ports, and ssh versions differ on which wins", destination);
  return { ok: true, destination, user: [...users][0] ?? null, port: [...ports][0] ?? null, hostName };
}

function portOf(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** The Inventory Host a nested ssh goes to. `target` is the host its password prompt names (ssh
 * prints it lowercased, after any HostName), `user` the login it must name. `sshFill`/`sudoFill`:
 * why roster won't fill that Host's ssh prompt or its sudo prompt here, or null when it may. */
export type Hop =
  | {
      known: true;
      host: string;
      target: string;
      address: string;
      port: number;
      user: string;
      sshFill: string | null;
      sudoFill: string | null;
    }
  | { known: false; label: string; why: string };

/** The Host fields a hop is matched on. */
export type HopHost = Pick<Host, "name" | "ip" | "reviewed" | "enroll" | "ssh">;

const LOOPBACK = /^(localhost(\.localdomain)?|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/i;

/** Where `command` goes, if it's an ssh: the one Inventory Host it reaches, or why it's none. */
export function resolveHop(command: string, hosts: readonly HopHost[]): Hop | null {
  const parsed = parseSsh(command);
  if (parsed === null) return null;
  if (!parsed.ok) return { known: false, label: parsed.destination?.toLowerCase() ?? "?", why: parsed.why };
  const target = (parsed.hostName ?? parsed.destination).toLowerCase();
  if (LOOPBACK.test(target)) {
    return { known: false, label: target, why: `${target} is this machine, and through a tunnel it may be any machine` };
  }
  const port = parsed.port ?? 22;
  const named = hosts.filter((h) => h.name.toLowerCase() === target || h.ip.toLowerCase() === target);
  const matches = named.filter((h) => h.ssh.port === port);
  if (matches.length > 1) {
    return { known: false, label: target, why: `${target}:${port} is ${matches.map((h) => h.name).join(" and ")} in the Inventory` };
  }
  const h = matches[0];
  if (!h) {
    const other = named[0];
    const why = other
      ? `${other.name} is at port ${other.ssh.port} in the Inventory, and this ssh goes to ${port}`
      : `${target} isn't a Host of the Inventory`;
    return { known: false, label: target, why };
  }
  const user = parsed.user ?? h.ssh.user;
  const otherUser = user !== h.ssh.user ? `this ssh logs in as ${user}, and roster has ${h.ssh.user}'s Login for ${h.name}` : null;
  const unreviewed = h.reviewed ? null : `${h.name} isn't reviewed`;
  const keyed = h.enroll || (NO_PASSWORD_AUTHS as readonly string[]).includes(h.ssh.auth);
  const noPassword = keyed
    ? `${h.name} logs in with a key, so roster types nothing into its ssh`
    : h.ssh.auth === "prompt"
      ? `${h.name}'s Login has no saved password (auth: prompt)`
      : null;
  return {
    known: true,
    host: h.name,
    target,
    address: h.ip,
    port,
    user,
    sshFill: unreviewed ?? otherUser ?? noPassword,
    sudoFill: unreviewed ?? otherUser,
  };
}
