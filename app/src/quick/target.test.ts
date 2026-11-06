import { describe, expect, it } from "vitest";
import vectors from "../../../tests/vectors/quick-target.json";
import { formatQuickTarget, parseQuickTarget } from "./target";

describe("a Quick Connect address (ticket 14)", () => {
  it("reads user@address, with an optional :port", () => {
    expect(parseQuickTarget("root@10.0.0.5")).toEqual({ user: "root", address: "10.0.0.5", port: 22 });
    expect(parseQuickTarget("  admin@sw-core.lab:2222 ")).toEqual({ user: "admin", address: "sw-core.lab", port: 2222 });
    expect(parseQuickTarget("pi@[fe80::1]:2200")).toEqual({ user: "pi", address: "fe80::1", port: 2200 });
    expect(parseQuickTarget("pi@fe80::1")).toEqual({ user: "pi", address: "fe80::1", port: 22 });
  });

  it("is not one without a user, an address, or with anything ssh could read as an option", () => {
    for (const text of [
      "",
      "esxi-02",
      "10.0.0.5",
      "@10.0.0.5",
      "root@",
      "root@10.0.0.5:0",
      "root@10.0.0.5:65536",
      "root@10.0.0.5:22x",
      "-oProxyCommand=x@10.0.0.5",
      "root@-oProxyCommand=x",
      "ro ot@10.0.0.5",
      "root@10.0.0.5 extra",
      "a@b@c",
    ]) {
      expect(parseQuickTarget(text), text).toBeNull();
    }
  });

  it("writes the port only when it isn't 22, and brackets an IPv6 address that has one", () => {
    expect(formatQuickTarget({ user: "root", address: "10.0.0.5", port: 22 })).toBe("root@10.0.0.5");
    expect(formatQuickTarget({ user: "root", address: "10.0.0.5", port: 2222 })).toBe("root@10.0.0.5:2222");
    expect(formatQuickTarget({ user: "pi", address: "fe80::1", port: 2200 })).toBe("pi@[fe80::1]:2200");
    expect(formatQuickTarget({ user: "pi", address: "fe80::1", port: 22 })).toBe("pi@fe80::1");
  });
});

describe("the cases serve shares (tests/vectors/quick-target.json)", () => {
  it("labels a Quick Connect as serve does", () => {
    for (const c of vectors.labels) {
      expect(formatQuickTarget({ user: c.user, address: c.address, port: c.port }), c.label).toBe(c.label);
    }
  });

  it("takes the users serve takes, and no other", () => {
    for (const user of vectors.users.valid) expect(parseQuickTarget(`${user}@10.0.0.5`), user).not.toBeNull();
    for (const user of vectors.users.invalid) expect(parseQuickTarget(`${user}@10.0.0.5`), user).toBeNull();
  });
});
