// Reading a command line the shell's `C` mark says it ran (Q129, Q131): words, the program, and
// whether it may reach another machine. One place for prompt.ts and sshTarget.ts. Plain text only:
// no shell is run, so a line roster can't read word for word (shell syntax, `$(…)`) is doubtful.

/** Shell syntax that runs more than one program, or one roster can't see. */
export const SHELL_SYNTAX = /[;&|`<>(){}]|\$\(/;
/** `VAR=value` before a command. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A word's program name: quotes around it and any directory taken off. */
export const base = (word: string) => word.replace(/^['"]+|['"]+$/g, "").split("/").pop() ?? "";

/** The line's words, split at whitespace. */
export const words = (command: string) => command.trim().split(/\s+/).filter(Boolean);

/** Where the command's own program is: the first word after any `VAR=value`. */
export function programAt(ws: readonly string[]): number {
  let i = 0;
  while (i < ws.length && ASSIGNMENT.test(ws[i] ?? "")) i++;
  return i;
}

/** Programs that reach another machine or a container, or attach to a terminal that may be one:
 * a prompt while one runs may be that machine's. */
const REACH = new Set([
  "ssh", "slogin", "mosh", "telnet", "rlogin", "rsh", "autossh", "sshpass", "docker", "podman", "kubectl", "oc",
  "lxc", "lxc-attach", "incus", "nc", "ncat", "netcat", "socat", "virsh", "machinectl", "nsenter", "pdsh",
  "vagrant", "multipass", "screen", "tmux", "expect", "eval",
]); // prettier-ignore
/** REACH, and programs that copy to another machine or run another program that may: sudo running
 * any of them is not sudo alone. */
const NOT_SUDO_ALONE = new Set([
  ...REACH, "ssh-copy-id", "scp", "sftp", "rsync", "ftp", "chroot", "su", "sudo", "doas", "ansible", "salt",
  "script", "env", "exec", "command", "time", "nice", "nohup", "stdbuf", "timeout", "xargs", "watch",
]); // prettier-ignore
/** sudo's options that take a value. */
const SUDO_ARG = new Set([
  "-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt",
  "--close-from", "--chdir", "--role", "--type", "--other-user", "--command-timeout",
]); // prettier-ignore

/** Whether `command` runs sudo itself and nothing that reaches another machine: env assignments,
 * then `sudo`, its options, and a program that isn't one of NOT_SUDO_ALONE (nor is any word after it). */
export function sudoOnly(command: string): boolean {
  if (SHELL_SYNTAX.test(command)) return false;
  const ws = words(command);
  let i = programAt(ws);
  if (base(ws[i] ?? "") !== "sudo") return false;
  i++;
  while ((ws[i] ?? "").startsWith("-")) {
    const opt = ws[i] ?? "";
    i++;
    if (opt === "--") break;
    if (SUDO_ARG.has(opt)) i++;
  }
  return ws.slice(i).every((w) => !NOT_SUDO_ALONE.has(base(w)));
}

/** Whether `command` may reach another machine (or a container), so what it prints, its prompts
 * and any shell marks included, may be that machine's: a word naming such a program, `$(…)` or a
 * backquote (roster can't see what they run), or a line roster couldn't read (null). An alias is
 * beyond it: roster reads the line, it doesn't run the shell. */
export function mayReachElsewhere(command: string | null): boolean {
  if (command === null || /\$\(|`/.test(command)) return true;
  return words(command).some((w) => REACH.has(base(w)));
}
