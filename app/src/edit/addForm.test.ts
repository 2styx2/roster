// The add-Host form's checks and suggestions (ticket 11), apart from React.
import { describe, expect, it } from "vitest";
import { makeHosts } from "../backend/fake";
import { addParams, addProblem, emptyDraft, filled, isNewGroup, itemRef, itemSuggestions, sameAddress, type AddDraft } from "./addForm";

const hosts = makeHosts(12);
const draft = (over: Partial<AddDraft> = {}): AddDraft => ({
  ...emptyDraft("subnet-1"),
  name: "nas-01",
  address: "10.19.1.50",
  user: "admin",
  ...over,
});

describe("the add form's checks", () => {
  it("refuses an empty, odd or taken name, as roster would", () => {
    expect(addProblem("name", draft({ name: "" }), hosts)).toBe("Can't be empty");
    expect(addProblem("name", draft({ name: "nas 01" }), hosts)).toMatch(/Letters, digits/);
    expect(addProblem("name", draft({ name: "-nas" }), hosts)).toMatch(/starting with a letter or digit/);
    expect(addProblem("name", draft({ name: "linux-1-000" }), hosts)).toBe("Already a Host, in subnet-1");
    expect(addProblem("name", draft(), hosts)).toBeNull();
  });

  it("checks the address, user, port and group", () => {
    expect(addProblem("address", draft({ address: "10.0.0.1 x" }), hosts)).toBe("Can't contain spaces");
    expect(addProblem("user", draft({ user: "" }), hosts)).toBe("Can't be empty");
    expect(addProblem("port", draft({ port: "70000" }), hosts)).toBe("A number from 1 to 65535");
    expect(addProblem("group", draft({ group: "lab gear" }), hosts)).toMatch(/Letters, digits/);
  });

  it("wants a reference for an existing item and a bare name for a new one", () => {
    expect(addProblem("item", draft({ login: "item", item: "esx ssh" }), hosts)).toMatch(/bw:esx-02 ssh/);
    expect(addProblem("item", draft({ login: "item", item: "bw:esx ssh" }), hosts)).toBeNull();
    expect(addProblem("item", draft({ login: "password", item: "bw:nas ssh" }), hosts)).toMatch(/without a provider/);
  });

  it("knows a new group from an existing one", () => {
    expect(isNewGroup(draft(), hosts)).toBe(false);
    expect(isNewGroup(draft({ group: "dmz" }), hosts)).toBe(true);
  });
});

describe("Vault item suggestions follow `<host> <what it opens>`", () => {
  it("names the new item after the Host", () => {
    expect(itemSuggestions(draft(), hosts)).toEqual(["nas-01 ssh", "nas-01 ssh+web", "nas-01 root"]);
    expect(itemSuggestions(draft({ name: "" }), hosts)).toEqual([]);
  });

  it("offers references for an existing item, with the Inventory's shared ones", () => {
    const withShared = { ...hosts, hosts: [...hosts.hosts, { ...hosts.hosts[0]!, name: "x", ssh: { user: "a", port: 22, auth: "bw:shared hub ssh" } }] };
    const got = itemSuggestions(draft({ login: "item" }), withShared);
    expect(got.slice(0, 3)).toEqual(["bw:nas-01 ssh", "bw:nas-01 ssh+web", "bw:nas-01 root"]);
    expect(got).toContain("bw:shared hub ssh");
    expect(got).not.toContain("bw:linux-0 ssh");
  });
});

describe("host.add's params", () => {
  it("saves a typed password as `<host> ssh` unless named, and never keeps it in the draft", () => {
    const d = draft({ type: " nas ", title: "The  NAS" });
    expect(addParams(d, hosts, "pw")).toEqual({
      name: "nas-01",
      group: "subnet-1",
      address: "10.19.1.50",
      user: "admin",
      port: 22,
      enroll: false,
      type: "nas",
      title: "The NAS",
      password: "pw",
      item: "nas-01 ssh",
    });
    expect(Object.values(d)).not.toContain("pw");
    expect(addParams(draft({ item: "nas-01 ssh+web" }), hosts, "pw")?.item).toBe("nas-01 ssh+web");
  });

  it("says where to save a typed password when Save to chose (ticket 35), and only then", () => {
    const team = { organization: "o1", collection: "c1" };
    expect(addParams(draft({}), hosts, "pw", team)?.save_to).toEqual(team);
    expect(addParams(draft({}), hosts, "pw")).not.toHaveProperty("save_to");
    expect(addParams(draft({ login: "item" }), hosts, undefined, team)).not.toHaveProperty("save_to");
  });

  it("points at an existing item, or has no Login at all", () => {
    expect(addParams(draft({ login: "item" }), hosts)?.auth).toBe("bw:nas-01 ssh");
    const none = addParams(draft({ login: "none" }), hosts);
    expect(none && ("auth" in none || "password" in none)).toBe(false);
  });

  it("is null while a field is wrong", () => {
    expect(addParams(draft({ port: "x" }), hosts, "pw")).toBeNull();
  });
});

describe("another Host at the same address and port (#437: a warning, never a refusal)", () => {
  it("names the Hosts at that address and SSH port", () => {
    expect(sameAddress(draft({ address: "10.19.1.2" }), hosts)).toEqual(["linux-1-000"]);
    expect(sameAddress(draft({ address: "10.19.1.2", port: "2222" }), hosts)).toEqual([]);   // a second sshd
    expect(sameAddress(draft(), hosts)).toEqual([]);
  });

  it("compares names without case or a final dot (IPs as typed)", () => {
    const named = { ...hosts, hosts: [{ ...hosts.hosts[0]!, ip: "NAS-01.lan" }] };
    expect(sameAddress(draft({ address: "nas-01.lan." }), named)).toEqual(["linux-1-000"]);
  });

  it("says nothing while the address or port isn't one yet", () => {
    expect(sameAddress(draft({ address: "" }), hosts)).toEqual([]);
    expect(sameAddress(draft({ address: "10.19.1.2", port: "x" }), hosts)).toEqual([]);
  });

  it("doesn't change host.add's params: roster takes it", () => {
    expect(addParams(draft({ address: "10.19.1.2", login: "none" }), hosts)).toMatchObject({ address: "10.19.1.2" });
  });
});

describe("fill from a vault item (#437, API 29)", () => {
  it("reads the item the Login names, or the one it would name", () => {
    expect(itemRef(draft({ login: "item", item: "bw:nas ssh" }))).toEqual({ provider: "bw", item: "nas ssh" });
    expect(itemRef(draft({ login: "item", item: "" }))).toEqual({ provider: "bw", item: "nas-01 ssh" });
    expect(itemRef(draft({ login: "item", item: "nas ssh" }))).toBeNull();
    expect(itemRef(draft({ login: "password" }))).toBeNull();
  });

  it("asks for the item, not its #field (review of #458, L3)", () => {
    expect(itemRef(draft({ login: "item", item: "bw:nas ssh#password2" }))).toEqual({ provider: "bw", item: "nas ssh" });
    expect(itemRef(draft({ login: "item", item: "bw:#x" }))).toBeNull();
  });

  it("names no item while both Name and Vault item are empty (L4)", () => {
    expect(itemRef(draft({ login: "item", name: "", item: "" }))).toBeNull();
  });

  it("fills the address, port and user the item has, and says which changed", () => {
    const d = draft({ address: "", user: "admin", port: "22" });
    const { draft: next, changed } = filled(d, { provider: "bw", item: "nas ssh", address: "10.0.0.5", port: 2222, user: "root" });
    expect(next).toMatchObject({ address: "10.0.0.5", port: "2222", user: "root", name: "nas-01" });
    expect(changed).toEqual(["address", "port", "user"]);
  });

  it("leaves a field the item doesn't have as typed", () => {
    const { draft: next, changed } = filled(draft({ user: "admin" }), { provider: "bw", item: "x", user: "admin" });
    expect(next.address).toBe("10.19.1.50");
    expect(changed).toEqual([]);
  });
});
