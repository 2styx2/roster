import { describe, expect, it } from "vitest";
import { addressCut, middleCut } from "./format";

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
