import { describe, expect, it } from "vitest";
import { searchHosts } from "./match";
import { budget } from "../test-budget";
import type { Host, HostList } from "../backend/types";

function host(name: string, more: Partial<Host> = {}): Host {
  return {
    name, group: "lab", ip: "10.0.0.1", type: "linux", product: "", title: "", description: "",
    reviewed: true, enroll: true, ssh: { user: "root", port: 22, auth: "key" }, web: null, ...more,
  };
}

function names(list: HostList, query: string, recent: string[] = []): string[] {
  return searchHosts(list, query, recent).map((r) => r.host.name);
}

const groups = { lab: { title: "Lab bench", description: "" }, core: { title: "10.19.1.0/24 servers", description: "" } };

describe("searchHosts", () => {
  it("lists every Host in Inventory order when the query is empty", () => {
    const list = { hosts: [host("b"), host("a"), host("c")], groups };
    expect(names(list, "")).toEqual(["b", "a", "c"]);
  });

  it("finds a Host by any part of its name, ignoring case", () => {
    const list = { hosts: [host("proxmox-01"), host("ESXi-02"), host("unifi")], groups };
    expect(names(list, "esx")).toEqual(["ESXi-02"]);
  });

  it("matches address, type, product, title and group", () => {
    const list = {
      hosts: [
        host("a", { ip: "10.19.77.237" }),
        host("b", { type: "switch" }),
        host("c", { product: "ALPHA" }),
        host("d", { title: "Contoso lab mini" }),
        host("e", { group: "core" }),
      ],
      groups,
    };
    expect(names(list, "77.237")).toEqual(["a"]);
    expect(names(list, "switch")).toEqual(["b"]);
    expect(names(list, "alph")).toEqual(["c"]);
    expect(names(list, "contoso")).toEqual(["d"]);
    expect(names(list, "core")).toEqual(["e"]);
  });

  it("ranks an exact name, then a prefix, then a word inside, then letters in order", () => {
    const list = { hosts: [host("x-h-u-b-2"), host("lab-hub2"), host("hub2-old"), host("hub2"), host("ohub2")], groups };
    expect(names(list, "hub2")).toEqual(["hub2", "hub2-old", "lab-hub2", "ohub2", "x-h-u-b-2"]);
  });

  it("ranks a name match above the same text in a title", () => {
    const list = { hosts: [host("gw", { title: "proxmox gateway" }), host("proxmox-2")], groups };
    expect(names(list, "proxmox")).toEqual(["proxmox-2", "gw"]);
  });

  it("doesn't match a group's title, only its name", () => {
    const list = { hosts: [host("unifi", { group: "core" }), host("esxi-1")], groups };
    expect(names(list, "servers")).toEqual([]);
  });

  it("matches scattered letters only in short fields, not in prose titles", () => {
    const list = { hosts: [host("gw", { title: "edge switch near xi rack" }), host("e-s-x-i")], groups };
    expect(names(list, "esxi")).toEqual(["e-s-x-i"]);
  });

  it("needs every word of the query to match somewhere", () => {
    const list = { hosts: [host("esxi-1", { group: "core" }), host("esxi-2"), host("pve", { group: "core" })], groups };
    expect(names(list, "core esxi")).toEqual(["esxi-1"]);
  });

  it("breaks ties by how recently a Host was used", () => {
    const list = { hosts: [host("esxi-1"), host("esxi-2"), host("esxi-3")], groups };
    expect(names(list, "esxi", ["esxi-3", "esxi-2"])).toEqual(["esxi-3", "esxi-2", "esxi-1"]);
    expect(names(list, "", ["esxi-2"])).toEqual(["esxi-2", "esxi-1", "esxi-3"]);
  });

  budget("filters a thousand Hosts quickly", () => {
    const hosts = Array.from({ length: 1000 }, (_, i) => host(`host-${i}`, { ip: `10.0.${i % 255}.${i % 7}`, title: `box ${i}` }));
    const start = performance.now();
    for (const q of ["h", "ho", "hos", "host-9", "host-99", "10.0.9"]) searchHosts({ hosts, groups }, q, []);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
