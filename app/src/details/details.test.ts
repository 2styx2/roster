// Host details (ticket 18): what `roster hosts HOST` says, as rows, and which web services open.
import { describe, expect, it } from "vitest";
import type { Host, HostList, Service } from "../backend/types";
import urlCases from "../../../crates/roster-core/tests/fixtures/web-urls.json";
import { hostFacts, resolveOpen, serviceRows, webServices, webUrl } from "./details";

const svc = (over: Partial<Service> = {}): Service => ({
  port: 443,
  url: "https://10.0.0.5",
  scheme: "https",
  user: null,
  auth: null,
  verify: true,
  login: "basic",
  override: false,
  ...over,
});

const esx: Host = {
  name: "esx-02",
  group: "lab",
  ip: "10.0.0.5",
  type: "esxi",
  product: "appliance",
  title: "Rack 2 hypervisor",
  description: "the one by the door",
  reviewed: true,
  enroll: false,
  ssh: { user: "root", port: 22, auth: "bw:esx-02 ssh" },
  login: { user: "root", auth: "bw:esx-02 ssh+web" },
  mac: "00:11:22:33:44:55",
  web: "https://10.0.0.5",
  services: {
    web: svc({ user: "root", auth: "bw:esx-02 ssh+web" }),
    admin: svc({ port: 8443, url: "https://10.0.0.5:8443", user: "webadmin", auth: "bw:esx-02 admin", override: true }),
    postgres: svc({ port: 5432, url: null, scheme: null }),
  },
};

const groups: HostList["groups"] = { lab: { title: "The lab", description: "" } };

describe("hostFacts", () => {
  it("says what roster hosts HOST says, in its order, leaving out the empty ones", () => {
    expect(hostFacts(esx, groups)).toEqual([
      { label: "title", value: "Rack 2 hypervisor" },
      { label: "description", value: "the one by the door" },
      { label: "type", value: "esxi", data: true },
      { label: "product", value: "appliance" },
      { label: "group", value: "lab (The lab)", data: true },
      { label: "address", value: "root@10.0.0.5:22", data: true },
      { label: "access", value: "password: roster run esx-02 -- CMD", data: true },
      { label: "mac", value: "00:11:22:33:44:55", data: true },
      { label: "ssh login", value: "root, auth bw:esx-02 ssh", data: true },
      { label: "login", value: "root, auth bw:esx-02 ssh+web (default for services)", data: true },
      { label: "web UI", value: "https://10.0.0.5", data: true },
    ]);
  });

  it("says key access for an enrolled Host and not set up for an unreviewed one", () => {
    const value = (h: Host) => hostFacts(h, {}).find((f) => f.label === "access")?.value;
    expect(value({ ...esx, enroll: true })).toBe("key: ssh esx-02");
    expect(value({ ...esx, reviewed: false })).toBe("not set up yet (reviewed: false)");
  });

  it("says a key Host's key type and the key file it logs in with, right after ssh login (T245)", () => {
    const fips: Host = { ...esx, enroll: true, key_type: "ecdsa", key_file: "/home/me/.ssh/roster_ecdsa" };
    const labels = hostFacts(fips, {}).map((f) => f.label);
    expect(labels.indexOf("ssh key")).toBe(labels.indexOf("ssh login") + 1);
    expect(hostFacts(fips, {}).find((f) => f.label === "ssh key")).toEqual({ label: "ssh key", value: "ecdsa, /home/me/.ssh/roster_ecdsa", data: true });
    // a password Host's key_type means nothing (Q200 (g)): no row; nor from a roster before API 30, which sent none
    expect(hostFacts({ ...fips, enroll: false }, {}).some((f) => f.label === "ssh key")).toBe(false);
    expect(hostFacts({ ...esx, enroll: true }, {}).some((f) => f.label === "ssh key")).toBe(false);
  });

  it("copes with a Host from a roster that sent no services, login or mac", () => {
    const bare: Host = { ...esx, title: "", description: "", product: "", web: null };
    delete bare.services;
    delete bare.login;
    delete bare.mac;
    expect(hostFacts(bare, {}).map((f) => f.label)).toEqual(["type", "group", "address", "access", "ssh login"]);
  });
});

describe("serviceRows", () => {
  it("lists every service with its port, url and Login, by the vault item's name only", () => {
    expect(serviceRows(esx)).toEqual([
      { name: "web", port: 443, url: "https://10.0.0.5", login: "root, auth bw:esx-02 ssh+web (host default)", open: "https://10.0.0.5" },
      { name: "admin", port: 8443, url: "https://10.0.0.5:8443", login: "webadmin, auth bw:esx-02 admin (own login)", open: "https://10.0.0.5:8443" },
      { name: "postgres", port: 5432, url: null, login: "no login", open: null },
    ]);
  });

  it("hides a password written into a URL, and doesn't offer to open it", () => {
    const h: Host = { ...esx, services: { odd: svc({ url: "https://admin:hunter2@10.0.0.5:9443/x" }) } };
    expect(serviceRows(h)[0]).toMatchObject({ url: "https://admin:•••@10.0.0.5:9443/x", open: null });
    const web = hostFacts({ ...h, web: "https://admin:hunter2@10.0.0.5:9443/x" }, {}).find((f) => f.label === "web UI");
    expect(web?.value).toBe("https://admin:•••@10.0.0.5:9443/x");
  });
});

describe("webUrl", () => {
  it("takes http and https URLs only", () => {
    expect(webUrl("https://10.0.0.5:8443/ui")).toBe("https://10.0.0.5:8443/ui");
    expect(webUrl("http://appliance.example")).toBe("http://appliance.example");
    expect(webUrl("file:///etc/passwd")).toBeNull();
    expect(webUrl("javascript:alert(1)")).toBeNull();
    expect(webUrl("ssh://10.0.0.5")).toBeNull();
    expect(webUrl("not a url")).toBeNull();
    expect(webUrl(null)).toBeNull();
  });

  it("never opens a URL that carries a user or password", () => {
    expect(webUrl("https://admin:hunter2@10.0.0.5")).toBeNull();
    expect(webUrl("https://admin@10.0.0.5")).toBeNull();
  });

  // The core's browser.rs checked_url runs the same table: a link the panel offers always opens.
  it.each(urlCases.open)("agrees with the core: opens %j", (url) => {
    expect(webUrl(url)).toBe(url);
  });
  it.each([...urlCases.refuse, ...urlCases.login])("agrees with the core: refuses %j", (url) => {
    expect(webUrl(url)).toBeNull();
  });
});

describe("webServices", () => {
  it("names the services that open in a browser", () => {
    expect(webServices(esx)).toEqual(["web", "admin"]);
    expect(webServices({ ...esx, services: {} })).toEqual([]);
  });
});

describe("resolveOpen", () => {
  const hosts = new Map([[esx.name, esx], ["nas-01", { ...esx, name: "nas-01", services: {} }]]);
  const at = (arg: string, current: string | null = null) => resolveOpen(arg, hosts, current);

  it("a Host's name opens the Host, as before", () => {
    expect(at("nas-01")).toEqual({ kind: "host", host: "nas-01" });
  });

  it("HOST SERVICE opens that Host's web service", () => {
    expect(at("esx-02 admin")).toEqual({ kind: "web", host: "esx-02", service: "admin", url: "https://10.0.0.5:8443" });
  });

  it("a service's name alone opens it on the current Host", () => {
    expect(at("admin", "esx-02")).toEqual({ kind: "web", host: "esx-02", service: "admin", url: "https://10.0.0.5:8443" });
  });

  it("a Host's name wins over a service of the same name", () => {
    expect(at("nas-01", "esx-02")).toEqual({ kind: "host", host: "nas-01" });
  });

  it("an open Session's host or a Quick Connect address opens (or goes back to) that Session, as before", () => {
    const withSessions = (arg: string, current: string | null = null) => resolveOpen(arg, hosts, current, ["root@10.0.0.9", "old-box"]);
    expect(withSessions("root@10.0.0.9", "esx-02")).toEqual({ kind: "host", host: "root@10.0.0.9" });
    expect(withSessions("old-box", "esx-02")).toEqual({ kind: "host", host: "old-box" });
    expect(at("admin@10.0.0.5:2222", "esx-02")).toEqual({ kind: "host", host: "admin@10.0.0.5:2222" });
  });

  it("a service only when no Host, Session or address matches", () => {
    const withSessions = resolveOpen("admin", hosts, "esx-02", ["admin"]);
    expect(withSessions).toEqual({ kind: "host", host: "admin" });
    expect(at("admin", "esx-02")).toEqual({ kind: "web", host: "esx-02", service: "admin", url: "https://10.0.0.5:8443" });
  });

  it("says why when there's nothing to open", () => {
    expect(at("admin")).toEqual({ kind: "error", message: "No Host named admin" });
    expect(at("ftp", "esx-02")).toEqual({ kind: "error", message: "No Host named ftp, and esx-02 has no web service ftp (web, admin)" });
    expect(at("esx-02 postgres")).toEqual({ kind: "error", message: "esx-02's postgres isn't a web service: it has no http or https URL" });
    expect(at("nobody web")).toEqual({ kind: "error", message: "No Host named nobody" });
    expect(at("ftp", "nas-01")).toEqual({ kind: "error", message: "No Host named ftp, and nas-01 has no web services" });
  });
});
