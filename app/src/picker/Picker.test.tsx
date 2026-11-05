import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { marked, Picker } from "./Picker";
import { renderToStaticMarkup } from "react-dom/server";
import type { Host, HostList } from "../backend/types";

function host(name: string, more: Partial<Host> = {}): Host {
  return {
    name, group: "lab", ip: "10.0.0.1", type: "linux", product: "", title: "", description: "",
    reviewed: true, enroll: true, ssh: { user: "root", port: 22, auth: "key" }, web: null, ...more,
  };
}

const list: HostList = {
  hosts: [
    host("esxi-02", { ip: "10.0.0.10", type: "esxi", group: "core" }),
    host("proxmox-01", { ip: "10.19.1.20", type: "proxmox", group: "core" }),
    host("scan-99", { ip: "10.0.0.99", reviewed: false }),
    host("unifi", { ip: "10.19.1.1", type: "router" }),
  ],
  groups: { core: { title: "Core servers", description: "" }, lab: { title: "Lab", description: "" } },
};

function setup(over: Partial<Parameters<typeof Picker>[0]> = {}) {
  const onOpen = vi.fn<(h: Host) => void>();
  const onClose = vi.fn<() => void>();
  render(<Picker hosts={list} recent={[]} vim onOpen={onOpen} onClose={onClose} {...over} />);
  return { onOpen, onClose, user: userEvent.setup() };
}

const rows = () => screen.getAllByRole("option");
const selected = () => screen.getByRole("option", { selected: true });

describe("Picker", () => {
  it("shows every Host with its name, address, group and type", () => {
    setup();
    expect(rows()).toHaveLength(4);
    const first = within(rows()[0]!);
    expect(first.getByText("esxi-02")).toBeInTheDocument();
    expect(first.getByText("10.0.0.10")).toBeInTheDocument();
    expect(first.getByText("core")).toBeInTheDocument();
    expect(first.getByText("esxi")).toBeInTheDocument();
  });

  it("focuses the query and filters as you type", async () => {
    const { user } = setup();
    expect(screen.getByRole("combobox")).toHaveFocus();
    await user.keyboard("prox");
    expect(rows().map((r) => r.dataset.host)).toEqual(["proxmox-01"]);
    await user.clear(screen.getByRole("combobox"));
    await user.keyboard("10.0.0");
    expect(rows().map((r) => r.dataset.host)).toEqual(["esxi-02", "scan-99"]);
  });

  it("says so when nothing matches", async () => {
    const { user } = setup();
    await user.keyboard("zzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/no hosts match/i)).toBeInTheDocument();
  });

  it("moves with the arrow keys and Ctrl+N / Ctrl+P, stopping at the ends", async () => {
    const { user } = setup();
    expect(selected().dataset.host).toBe("esxi-02");
    await user.keyboard("{ArrowDown}");
    expect(selected().dataset.host).toBe("proxmox-01");
    await user.keyboard("{Control>}n{/Control}");
    expect(selected().dataset.host).toBe("scan-99");
    await user.keyboard("{Control>}p{/Control}{ArrowUp}{ArrowUp}");
    expect(selected().dataset.host).toBe("esxi-02");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(selected().dataset.host).toBe("unifi");
  });

  it("moves with j / k once you're in the list, and goes back to typing on any other letter", async () => {
    const { user } = setup();
    await user.keyboard("{ArrowDown}jj");
    expect(selected().dataset.host).toBe("unifi");
    await user.keyboard("k");
    expect(selected().dataset.host).toBe("scan-99");
    await user.keyboard("u");
    expect(screen.getByRole("combobox")).toHaveValue("u");
    expect(rows()[0]!.dataset.host).toBe("unifi");
  });

  it("types j and k into the query when vim keys are off", async () => {
    const { user } = setup({ vim: false });
    await user.keyboard("{ArrowDown}j");
    expect(screen.getByRole("combobox")).toHaveValue("j");
  });

  it("opens the selected Host with Enter", async () => {
    const { user, onOpen } = setup();
    await user.keyboard("unifi{Enter}");
    expect(onOpen).toHaveBeenCalledWith(list.hosts[3]);
  });

  it("opens a Host on click", async () => {
    const { user, onOpen } = setup();
    await user.click(screen.getByText("proxmox-01"));
    expect(onOpen).toHaveBeenCalledWith(list.hosts[1]);
  });

  it("underlines what the query matched, a term whole where it appears, else its letters", () => {
    const html = (n: React.ReactNode) => renderToStaticMarkup(<>{n}</>);
    expect(html(marked("esx-02", "x-0"))).toBe("es<mark>x-0</mark>2");
    expect(html(marked("proxmox-3-002", "pm3"))).toBe("<mark>p</mark>rox<mark>m</mark>ox-<mark>3</mark>-002");
    expect(html(marked("router", "zz"))).toBe("router");
  });

  it("marks unreviewed Hosts and won't open them", async () => {
    const { user, onOpen } = setup();
    const row = rows().find((r) => r.dataset.host === "scan-99")!;
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText(/unreviewed/i)).toBeInTheDocument();
    await user.keyboard("scan{Enter}");
    expect(onOpen).not.toHaveBeenCalled();
    // The notice, beside the hidden count that a screen reader hears.
    expect(screen.getAllByRole("status").map((s) => s.textContent).join(" ")).toMatch(/scan-99 isn't reviewed/i);
    await user.click(screen.getByTitle("scan-99"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("puts an unreviewed Host's badge beside its name, with no column of its own (round 18)", () => {
    setup();
    const row = rows().find((r) => r.dataset.host === "scan-99")!;
    const badge = within(row).getByText("unreviewed");
    // In the name's cell, so rows without a badge give that room to the name and the group.
    expect(badge.parentElement).toHaveClass("host-cell");
    expect(badge.parentElement?.querySelector(".host-name")).toHaveTextContent("scan-99");
    // The sizer row (the columns' widths) has no badge cell.
    expect(document.querySelector(".picker-sizer .badge")).toBeNull();
  });

  it("gives the Quick Connect row Quick Connect's own glyph, and says what to type (round 18, 19)", async () => {
    const { user } = setup({ onQuick: vi.fn() });
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "Find a Host, or type user@address");
    await user.keyboard("root@10.0.0.9");
    const quick = rows()[0]!;
    expect(quick).toHaveTextContent(/Quick Connect/);
    // Not a Host's closed ring (a password login): the title bar's square, edge and open ring.
    expect(quick.querySelector("svg.dot")).toBeNull();
    const glyph = quick.querySelector(".quick-node svg");
    expect(glyph?.querySelector("rect")).not.toBeNull();
    expect(glyph?.querySelectorAll("path")).toHaveLength(2);
  });

  describe("with nothing matching (round 19)", () => {
    const next = () => document.querySelector(".picker-empty-next");
    it("offers Add a Host with its keys, and user@address in Iosevka, where each can be done", async () => {
      const onAdd = vi.fn();
      const { user } = setup({ onQuick: vi.fn(), onAdd, addKeys: "␣ +" });
      await user.keyboard("zzzz");
      expect(next()).toHaveTextContent(/Add a Host.*, or type user@address to connect to a box that isn't in the Inventory\./);
      expect(next()?.querySelector("code")).toHaveTextContent(/^user@address$/);
      expect(next()?.querySelector(".keycap")).not.toBeNull();
      await user.click(screen.getByRole("button", { name: "Add a Host" }));
      expect(onAdd).toHaveBeenCalledOnce();
    });
    it("says only what this roster can do", async () => {
      const { user } = setup({ onAdd: vi.fn() });
      await user.keyboard("zzzz");
      expect(next()).toHaveTextContent(/^Add a Host\.$/);
      expect(next()?.querySelector("code")).toBeNull();
    });
    it("without either, says what was searched", async () => {
      const { user } = setup();
      await user.keyboard("zzzz");
      expect(screen.queryByRole("button", { name: "Add a Host" })).toBeNull();
      expect(next()).toHaveTextContent(/Backspace widens the search/);
    });
  });

  describe("edge stubs with nine or more Sessions (Q219 a, extended by Q235)", () => {
    const live = new Map([
      ["esxi-02", "current" as const],
      ["proxmox-01", "live" as const],
    ]);
    const stubOf = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`) }).querySelector("line.stub");
    it("keeps every live Host's stub with fewer Sessions", () => {
      setup({ live });
      expect(stubOf("esxi-02")).not.toBeNull();
      expect(stubOf("proxmox-01")).not.toBeNull();
    });
    it("drops other live Hosts' stubs, keeping their colour, and keeps the on-screen Host's", () => {
      setup({ live, manySessions: true });
      expect(stubOf("esxi-02")).not.toBeNull();
      expect(stubOf("proxmox-01")).toBeNull();
      expect(screen.getByRole("option", { name: /^proxmox-01/ }).querySelector("svg.dot")).toHaveClass("on");
    });
  });

  it("lets a Host with no type give its type cell to its group, never its address cell (round 19)", () => {
    render(
      <Picker
        hosts={{ ...list, hosts: [host("bare", { ip: "", type: "", group: "a-long-group-name" }), ...list.hosts] }}
        recent={[]}
        vim
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const bare = screen.getByRole("option", { name: /^bare/ });
    expect(bare.querySelector(".host-group")).toHaveClass("wide");
    expect(bare.querySelector(".host-type")).toBeNull();
    // The empty address keeps its cell, so the group starts at its own column as on every row.
    expect(bare.querySelector(".host-ip")).not.toBeNull();
    expect(screen.getByRole("option", { name: /^esxi-02/ }).querySelector(".host-group")).not.toHaveClass("wide");
  });

  it("closes with Esc, even from the list", async () => {
    const { user, onClose } = setup();
    await user.keyboard("{ArrowDown}{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("puts recently used Hosts first", () => {
    setup({ recent: ["unifi"] });
    expect(rows()[0]!.dataset.host).toBe("unifi");
  });

  it("tells a screen reader how many Hosts a query left, once typing pauses", async () => {
    const { user } = setup();
    const said = () => screen.getAllByRole("status").map((s) => s.textContent).join("|");
    await user.keyboard("zzqxj");
    expect(said()).not.toContain("No Hosts match");
    await waitFor(() => expect(said()).toContain("No Hosts match"));
    await user.clear(screen.getByRole("combobox"));
    await user.keyboard("esxi");
    await waitFor(() => expect(said()).toContain("1 Host"));
  });
});

