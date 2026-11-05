import { describe, expect, it } from "vitest";
import { addressCut, endSplit, fitMiddle, middleCut } from "./format";

describe("addressCut", () => {
  it("leaves an address that fits", () => {
    expect(addressCut("10.0.0.5", 22)).toBe("10.0.0.5");
  });

  it("drops whole groups from the middle, never cutting one", () => {
    const cut = addressCut("2001:db8:85a3:0:0:8a2e:370:7334", 22);
    expect(cut).toBe("2001:db8:…:370:7334");
    for (const group of cut.replace("…", "").split(":").filter(Boolean)) {
      expect("2001:db8:85a3:0:0:8a2e:370:7334".split(":")).toContain(group);
    }
  });

  it("keeps the zone with the last group", () => {
    expect(addressCut("fe80::1ff:fe23:4567:890a%eth0", 22).endsWith(":890a%eth0")).toBe(true);
  });
});

describe("middleCut", () => {
  it("keeps the start and the end", () => {
    expect(middleCut("server-10-0-0-203-very-long", 11)).toBe("serve…-long");
  });
});

describe("endSplit", () => {
  it("keeps the last whole parts that fit, so groups that differ at the end stay apart", () => {
    const g = "fieldwork-east-ridge-building-4-servers-and-storage";
    expect(g.slice(endSplit(g) ?? 0)).toBe("and-storage");
    const s2 = "fieldwork-east-ridge-building-4-s2";
    expect(s2.slice(endSplit(s2) ?? 0)).toBe("building-4-s2");
  });

  it("leaves a short name whole, and splits a name with no separator at its last characters", () => {
    expect(endSplit("subnet-3")).toBeNull();
    const word = "Benachrichtigungseinstellungen";
    expect(word.slice(endSplit(word) ?? 0)).toBe("seinstellungen");
  });
});

describe("fitMiddle", () => {
  // One unit per character, so widths read as character counts.
  const chars = (s: string) => Array.from(s).length;
  it("keeps the start and the last whole parts, with one … and no dangling separator", () => {
    const g = "fieldwork-east-ridge-building-4-servers-and-storage";
    expect(fitMiddle(g, 21, chars)).toBe("fieldwork…and-storage");
    expect(fitMiddle(g, 33, chars)).toBe("fieldwork-east-ridge…and-storage");
    expect(fitMiddle("fieldwork-east-ridge-building-4-s1", 22, chars)).toBe("fieldwor…building-4-s1");
  });

  it("leaves what fits", () => {
    expect(fitMiddle("subnet-3", 21, chars)).toBe("subnet-3");
  });
});
