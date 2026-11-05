import { describe, expect, it } from "vitest";
import { giveWay, nameForms } from "./FitBar";

/** A 400 px bar whose segments are `widths` wide (jsdom has no layout): a Box, a path and three
 * hints. The bar's content is the sum of what's still shown. */
function bar(widths: { box: number; path: number; hints: number[]; forms?: number[] }) {
  const el = document.createElement("footer");
  Object.defineProperty(el, "clientWidth", { value: 400 });
  const box = document.createElement("span");
  box.className = "box";
  const cut = document.createElement("span");
  cut.className = "statusbar-cut";
  Object.defineProperty(cut, "scrollWidth", { value: 10 });
  Object.defineProperty(cut, "clientWidth", { value: 10 });
  box.append(cut);
  const path = document.createElement("span");
  path.className = "path";
  // Its forms (PathText): whole, then whole folders dropped, each 40 px shorter.
  const text = document.createElement("span");
  text.className = "path-text";
  const forms = (widths.forms ?? [widths.path]).map((_, i) => {
    const f = document.createElement("span");
    f.className = "path-cut";
    if (i > 0) f.setAttribute("data-off", "");
    return f;
  });
  text.append(...forms);
  path.append(text);
  const hints = document.createElement("span");
  hints.className = "statusbar-hints";
  const right = document.createElement("span");
  right.append(hints);
  const parts = widths.hints.map(() => document.createElement("button"));
  hints.append(...parts);
  el.append(box, path, right);
  const width = () =>
    widths.box +
    (path.hasAttribute("data-off") ? 0 : (widths.forms?.[forms.findIndex((f) => !f.hasAttribute("data-off"))] ?? widths.path)) +
    parts.reduce((sum, p, i) => sum + (p.hasAttribute("data-off") ? 0 : (widths.hints[i] ?? 0)), 0);
  Object.defineProperty(el, "scrollWidth", { get: () => Math.max(400, width()) });
  return { el, path, parts, forms };
}

describe("the status bar gives way in order (round 19)", () => {
  it("first drops the path's folders form by form, and only as far as it must (round 20)", () => {
    const shown = (forms: HTMLElement[]) => forms.findIndex((f) => !f.hasAttribute("data-off"));
    const sizes = { box: 160, path: 0, hints: [60, 60], forms: [260, 160, 100, 90, 80] };
    const { el, path, parts, forms } = bar(sizes);
    giveWay(el);
    // 160 + 120 of hints leaves 120 for the path: the third form (100) is the first that fits.
    expect(shown(forms)).toBe(2);
    expect(parts.some((p) => p.hasAttribute("data-off"))).toBe(false);
    expect(path).not.toHaveAttribute("data-off");
    // Wider: back to the whole path.
    sizes.box = 20;
    giveWay(el);
    expect(shown(forms)).toBe(0);
    // Narrower than the least form beside the hints: the hints go, then the path.
    sizes.box = 300;
    giveWay(el);
    // Its next-to-least form (90) beside no hints; the least (80) comes only after the hints.
    expect(shown(forms)).toBe(3);
    expect(parts.every((p) => p.hasAttribute("data-off"))).toBe(true);
    expect(path).not.toHaveAttribute("data-off");
    sizes.box = 315;
    giveWay(el);
    expect(shown(forms)).toBe(4);
    sizes.box = 340;
    giveWay(el);
    expect(parts.every((p) => p.hasAttribute("data-off"))).toBe(true);
    expect(path).toHaveAttribute("data-off");
  });


  it("removes the hints last first, then the path, and only as many as it must", () => {
    const { el, path, parts } = bar({ box: 160, path: 120, hints: [60, 60, 60] });
    giveWay(el);
    // 460 px of content in 400: the last hint goes, and the rest fit.
    expect(parts.map((p) => p.hasAttribute("data-off"))).toEqual([false, false, true]);
    expect(parts[2]).toHaveAttribute("aria-hidden", "true");
    expect(path).not.toHaveAttribute("data-off");
  });

  it("removes the path once every hint is gone, and brings them back when there's room", () => {
    const sizes = { box: 300, path: 120, hints: [60, 60] };
    const { el, path, parts } = bar(sizes);
    giveWay(el);
    expect(parts.every((p) => p.hasAttribute("data-off"))).toBe(true);
    expect(path).toHaveAttribute("data-off");
    sizes.box = 100;
    giveWay(el);
    expect([path, ...parts].some((p) => p.hasAttribute("data-off"))).toBe(false);
    expect(path).not.toHaveAttribute("aria-hidden");
  });

  it("then removes the Backend, node and label, and cuts this Box's and the Session's names by their own forms, never clipped (round 21)", () => {
    const el = document.createElement("footer");
    Object.defineProperty(el, "clientWidth", { value: 340 });
    const seg = (cls: string, forms: string[] | null) => {
      const s = document.createElement("span");
      s.className = cls;
      const label = document.createElement("span");
      label.className = "statusbar-cut";
      for (const [i, f] of (forms ?? []).entries()) {
        const form = document.createElement("span");
        form.className = "path-cut";
        form.textContent = f;
        if (i > 0) form.setAttribute("data-off", "");
        label.append(form);
      }
      if (!forms) label.textContent = "WSL: FedoraLinux-44";
      s.append(label);
      el.append(s);
      return label;
    };
    const backend = seg("backend", null);
    const box = seg("box", nameForms("aleksandra-wisniewska-kowalczyk-fedoralinux-44"));
    const session = seg("session-seg", nameForms("linux-1-0040"));
    // 10 px a character, plus 50 px for the marks and the count.
    const shown = (label: HTMLElement) => (label.hasAttribute("data-off") || label.parentElement?.hasAttribute("data-off") ? "" : [...label.children].find((c) => !c.hasAttribute("data-off"))?.textContent ?? label.textContent ?? "");
    const width = () => 50 + [backend, box, session].reduce((sum, l) => sum + 10 * [...shown(l)].length, 0);
    Object.defineProperty(el, "scrollWidth", { get: () => Math.max(340, width()) });
    giveWay(el);
    // The Backend goes first, whole, its node with its label (round 22: not a bare dot); then the
    // Box's name steps to 16 characters.
    expect(backend.parentElement).toHaveAttribute("data-off");
    expect(shown(box)).toBe("aleksand…inux-44");
    expect(shown(session)).toBe("linux-1-0040");
    expect(width()).toBeLessThanOrEqual(340);
  });

  it("gives a name its forms: whole up to 24 characters, then cut in its middle to 24, 16 and 10", () => {
    expect(nameForms("devbox")).toEqual(["devbox"]);
    expect(nameForms("aleksandra-wisniewska-kowalczyk-fedoralinux-44")).toEqual([
      "aleksandra-w…oralinux-44",
      "aleksand…inux-44",
      "aleks…x-44",
    ]);
  });
});
