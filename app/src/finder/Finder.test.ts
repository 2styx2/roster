import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { footTag, footerCount, layOutHosts, layOutNames, layOutTitles, withData } from "./Finder";

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

describe("a Host row's columns (round 22)", () => {
  it("puts every address at the widest name's end and sizes the address and type columns", () => {
    const ul = document.createElement("ul");
    for (const [name, addr, type] of [[48, 80, 40], [400, 120, 56], [96, 0, 0]] as const) {
      const li = document.createElement("li");
      li.className = "finder-row host-row";
      const label = document.createElement("span");
      label.className = "finder-label";
      const n = document.createElement("span");
      Object.defineProperty(n, "scrollWidth", { value: name });
      label.append(n);
      const a = document.createElement("span");
      a.className = "finder-detail finder-addr";
      Object.defineProperty(a, "scrollWidth", { value: addr });
      const t = document.createElement("span");
      t.className = "finder-type";
      Object.defineProperty(t, "scrollWidth", { value: type });
      li.append(label, a, t);
      ul.append(li);
    }
    layOutHosts(ul);
    // One name column for the list (CSS caps it at 45% of the row), not a stop per name.
    expect(ul.style.getPropertyValue("--finder-host-w")).toBe("400px");
    expect(ul.style.getPropertyValue("--finder-addr-w")).toBe("120px");
    expect(ul.style.getPropertyValue("--finder-type-w")).toBe("56px");
  });
});

describe("Help's rows have no tag column (round 22)", () => {
  it("leaves the title everything but the widest page", () => {
    const ul = document.createElement("ul");
    for (const [title, page] of [[300, 90], [120, 134]] as const) {
      const li = document.createElement("li");
      li.className = "finder-row";
      const label = document.createElement("span");
      label.className = "finder-label";
      const n = document.createElement("span");
      Object.defineProperty(n, "scrollWidth", { value: title });
      label.append(n);
      const p = document.createElement("span");
      p.className = "finder-path";
      Object.defineProperty(p, "scrollWidth", { value: page });
      li.append(label, p);
      ul.append(li);
    }
    layOutTitles(ul);
    expect(ul.style.getPropertyValue("--finder-title-w")).toBe("300px");
    expect(ul.style.getPropertyValue("--finder-page-w")).toBe("134px");
  });

  it("breaks the footer's :help TAG only after its #, never inside the tag", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, footTag("help errors-guide#trusting-a-new-host-key")));
    expect(html).toBe('<span class="finder-foot-part">:help errors-guide#</span><wbr/><span class="finder-foot-part">trusting-a-new-host-key</span>');
    expect(renderToStaticMarkup(createElement(Fragment, null, footTag("help theme")))).toBe('<span class="finder-foot-part">:help theme</span>');
  });
});
