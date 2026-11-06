// Whether a key went to a field: a field keeps its letters (and its Esc), so a panel's own keys
// and the docs site's `/` leave it alone.

const FIELD = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/** True when `target` (a key event's) is a field or inside one. */
export function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FIELD) !== null;
}
