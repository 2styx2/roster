// What a Session's status means, for everything that shows or counts Sessions: the tab strip, the
// Sidebar, the finder, Plugins' session events and `:inventory`'s count of open Sessions.
import type { Tab, TabStatus } from "./tabs";

/** The Session is still going: not ended, not refused. */
export function isLive(status: TabStatus): boolean {
  return status.state !== "ended" && status.state !== "failed";
}

/** Where a Session is on its way to a shell (issue #78): `starting` while roster prepares it and
 * ssh starts on this Box, `logging-in` once ssh runs and the Host hasn't answered yet, null once
 * it has (or it ended, or was refused). For a Host whose key roster hasn't seen (ticket 36):
 * `checking-key` while its key is fetched, `asking` while the user decides, `trusting` while
 * roster records it. */
export type ConnectPhase = "starting" | "logging-in" | "checking-key" | "asking" | "trusting" | "password";

export function connectPhase(tab: Tab): ConnectPhase | null {
  const s = tab.status;
  if (s.state === "asking") return !s.key ? "checking-key" : s.trusting ? "trusting" : "asking";
  if (s.state === "password") return "password";
  if (s.state === "connecting") return "starting";
  if (s.state === "open" && !tab.shell) return "logging-in";
  return null;
}

/** How the Session's link to its Host stands, for the edge drawn from its node (taste.md: an
 * edge drawn on connect, snapping back on failure): drawing, up, or down. */
export function linkOf(tab: Tab): "connecting" | "up" | "down" {
  if (connectPhase(tab)) return "connecting";
  return tab.status.state === "open" ? "up" : "down";
}

export function statusText(tab: Tab): string {
  const s = tab.status;
  switch (s.state) {
    case "connecting":
      return "connecting…";
    case "asking":
      return s.key ? "new host key" : "connecting…";
    case "password":
      return "password";
    case "open":
      return tab.shell ? "" : "connecting…";
    case "failed":
      return "failed";
    case "ended":
      if (s.exit.closed) return "closed";
      return s.exit.code === null ? "ended (signal)" : `ended (code ${s.exit.code})`;
  }
}
