// Which OS the app runs on, known at once (the Windows build comes later, from the shell): the
// built-in keys depend on it (decision Q138). WebView2 says Windows in its user agent; a plain
// browser on Windows does too, and gets the same keys.

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  userAgentData?: { platform?: string };
}

/** True when the app runs on Windows. */
export function runsOnWindows(nav: NavigatorLike | undefined = globalThis.navigator as NavigatorLike | undefined): boolean {
  if (!nav) return false;
  const platform = nav.userAgentData?.platform;
  if (platform) return platform === "Windows";
  return /\bWindows\b/.test(nav.userAgent ?? "");
}

/** True on macOS, by xterm.js's own test (its `isMac`: `navigator.platform`), so roster and xterm
 * agree on which key takes the mouse back from a program. */
export function runsOnMac(nav: NavigatorLike | undefined = globalThis.navigator as NavigatorLike | undefined): boolean {
  return ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(nav?.platform ?? "");
}
