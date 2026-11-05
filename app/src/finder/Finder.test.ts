import { describe, expect, it } from "vitest";
import { footerCount, layOutNames } from "./Finder";

describe("the finder footer's count", () => {
  it("says how many there are before a query, and how many matched after (round 18)", () => {
    expect(footerCount(1360, 200, "", "topic")).toBe("1,360 topics");
    expect(footerCount(1, 1, "", "topic")).toBe("1 topic");
    expect(footerCount(1322, 200, "a", "topic")).toBe("200 of 1,322 results");
    expect(footerCount(34, 34, "pick", "topic")).toBe("34 results");
    expect(footerCount(300, 200, "")).toBe("200 of 300 results");
    expect(footerCount(0, 0, "x", "topic")).toBe("");
  });
});

describe("the finders' tab stops (round 18)", () => {
  /** A list of rows whose names measure `widths` px (jsdom has no layout). */
  function list(widths: number[]) {
    const ul = document.createElement("ul");
    for (const w of widths) {
      const li = document.createElement("li");
      li.className = "finder-row";
      li.style.fontSize = "15px";
      li.style.columnGap = "12px";
      const label = document.createElement("span");
      label.className = "finder-label";
      const name = document.createElement("span");
      Object.defineProperty(name, "scrollWidth", { value: w });
      label.append(name);
      li.append(label);
      ul.append(li);
    }
    return ul;
  }

  it("starts each path at the first 8ch stop past its name, so like names line up", () => {
    // 8ch of 15px Iosevka is 60px; the basis is the stop less the 12px gap.
    const ul = list([24, 28, 46, 88, 96, 192]);
    layOutNames(ul);
    const bases = [...ul.children].map((li) => (li as HTMLElement).style.getPropertyValue("--finder-name-basis"));
    expect(bases).toEqual(["48px", "48px", "48px", "108px", "108px", "228px"]);
  });
});
