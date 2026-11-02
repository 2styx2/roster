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

/** Programs that reach another machine, a container or a serial console, attach to a terminal
 * that may be one, or start a shell roster's marks don't see into: a prompt while one runs may be
 * that machine's. Best effort: roster reads the line, it doesn't run the shell, so an alias or a
 * script isn't caught; roster's own hook marks (with the Session's token) are the reliable path. */
const REACH = new Set([
  "ssh", "slogin", "mosh", "telnet", "rlogin", "rsh", "autossh", "sshpass", "docker", "podman", "nerdctl", "kubectl",
  "oc", "lxc", "lxc-attach", "incus", "nc", "ncat", "netcat", "socat", "virsh", "machinectl", "nsenter", "chroot",
  "pdsh", "vagrant", "multipass", "screen", "tmux", "expect", "eval", "cu", "minicom", "picocom", "microcom", "tio",
  "console", "conserver", "ipmitool", "su", "doas", "bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh", "csh",
  "busybox", "pwsh", "powershell",
]); // prettier-ignore
/** Cloud tools whose subcommand opens a shell on a machine: the tool and the word that does. */
const REACH_VIA: Record<string, readonly string[]> = {
  aws: ["ssm"],
  gcloud: ["ssh", "serial-port", "connect-to-serial-port"],
  az: ["ssh", "serial-console"],
};
/** sudo's options that start a shell. */
const SUDO_SHELL = new Set(["-i", "-s", "--login", "--shell"]);
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

/** Whether `command` may reach another machine (or a container, a console, a shell roster can't
 * see into), so what it prints, its prompts and any shell marks included, may be that machine's: a
 * word naming such a program, a cloud tool's shell subcommand, sudo starting a shell, `$(…)` or a
 * backquote (roster can't see what they run), or a line roster couldn't read (null). Best effort
 * (REACH): an alias or a script is beyond it. */
export function mayReachElsewhere(command: string | null): boolean {
  if (command === null || /\$\(|`/.test(command)) return true;
  const ws = words(command).map(base);
  if (ws.some((w) => REACH.has(w))) return true;
  if (ws.some((w, i) => (REACH_VIA[w] ?? []).some((sub) => ws.slice(i + 1).includes(sub)))) return true;
  return ws.includes("sudo") && ws.some((w) => SUDO_SHELL.has(w));
}
