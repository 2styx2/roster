// The message line draws a command it names in Iosevka (<code>, round 18), so its text is split
// across elements and getByText can't find it whole: this matcher finds the line by its text.
export function onMessageLine(want: string | RegExp) {
  return (_content: string, el: Element | null): boolean => {
    if (!el?.classList.contains("message-line")) return false;
    const text = el.textContent ?? "";
    return typeof want === "string" ? text === want : want.test(text);
  };
}
