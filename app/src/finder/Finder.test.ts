import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dropCutTags, footerCount, layOutNames, layOutTitles, withData } from "./Finder";

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

describe("a prose finder's one middle column (round 19)", () => {
  it("starts every row's middle column at the widest title's end", () => {
    const ul = document.createElement("ul");
    for (const [w, path] of [[40, true], [180, true], [400, false], [90, true]] as const) {
      const li = document.createElement("li");
      li.className = "finder-row";
      const label = document.createElement("span");
      label.className = "finder-label";
      const name = document.createElement("span");
      Object.defineProperty(name, "scrollWidth", { value: w });
      label.append(name);
      li.append(label);
      if (path) {
        const p = document.createElement("span");
        p.className = "finder-path";
        li.append(p);
      }
      ul.append(li);
    }
    layOutTitles(ul);
    // A row with no middle column (a page) doesn't count: nothing on it lines up.
    expect(ul.style.getPropertyValue("--finder-title-w")).toBe("180px");
  });

  it("sets what's code in a description in Iosevka", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, withData("Run roster sync: the config offers one key.", ["roster sync"])));
    expect(html).toBe('Run <span class="data">roster sync</span>: the config offers one key.');
  });
});

describe("a help tag is whole or not drawn (round 21)", () => {
  /** A row `width` px wide whose content measures `content` px. */
  function row(width: number, content: number) {
    const li = document.createElement("li");
    li.className = "finder-row";
    const size = { content };
    Object.defineProperty(li, "clientWidth", { value: width });
    Object.defineProperty(li, "scrollWidth", { get: () => size.content });
    const tag = document.createElement("span");
    tag.className = "finder-detail";
    li.append(tag);
    return { li, tag, size };
  }
  it("drops the tag of a row that can't hold it whole, keeps the others", () => {
    const ul = document.createElement("ul");
    const fits = row(400, 380);
    const over = row(400, 460);
    ul.append(fits.li, over.li);
    dropCutTags(ul);
    expect(fits.tag).not.toHaveAttribute("data-off");
    expect(over.tag).toHaveAttribute("data-off");
    // Room again (a wider window): drawn again.
    over.size.content = 300;
    dropCutTags(ul);
    expect(over.tag).not.toHaveAttribute("data-off");
  });
});
