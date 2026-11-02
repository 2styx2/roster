// The demo Inventory `:tutor` runs on (ticket 55, decision Q76): the fake Backend the UI tests use,
// with a few made-up Hosts whose Sessions are pretend shells in the app, so nothing tried here
// reaches a network, a vault or roster.yml. Its State lives in memory and is thrown away on
// leaving; the real Platform lends only what can't touch the real State or a Host: the window,
// the clipboard, fonts, and init.lua (read, and opened in the editor by `:config`). Your running
// Plugins come along (ticket 66, decision Q123) on the core's demo Plugin host: the demo's Hosts,
// no network, throwaway files.
import type { Backend, Host, HostList } from "../backend/types";
import { STATE_KEY as PLUGINS_KEY, type DemoPlugins } from "../plugins/manager";
import type { Platform } from "../platform/types";
import { HINTS_KEY } from "../ui/hints";
import { THEME_KEY, THEME_OVER_KEY } from "../theme/picker";

/** The demo's Hosts: names a tutorial can point at (`demo-01`), made-up addresses, every Login a
 * key, so no Session ever asks for a vault. */
export function demoHosts(): HostList {
  const kinds: [string, string][] = [
    ["linux", "A Linux box to practise on"],
    ["linux", "Another one, for a second Session"],
    ["proxmox", "A hypervisor"],
    ["switch", "A switch in the lab rack"],
    ["nas", "The lab's file server"],
    ["printer", "The office printer"],
  ];
  const hosts = kinds.map(([type, title], i): Host => {
    const n = String(i + 1).padStart(2, "0");
    return {
      name: `demo-${n}`,
      group: i < 4 ? "demo-lab" : "demo-office",
      ip: `10.0.0.${11 + i}`,
      type,
      product: "",
      title,
      description: "",
      reviewed: true,
      enroll: true,
      ssh: { user: "admin", port: 22, auth: "key" },
      services: {},
      login: { user: null, auth: null },
      web: null,
    };
  });
  return {
    hosts,
    groups: {
      "demo-lab": { title: "The demo lab (made up)", description: "" },
      "demo-office": { title: "The demo office (made up)", description: "" },
    },
  };
}

/** The demo's Backend, and what to do when the demo ends. */
export interface Demo {
  backend: Backend;
  /** Your Plugins as the demo loads them: null when it can't (`problem` says why), and then the
   * demo runs with its built-in Plugins only and none of yours is put in its State. */
  plugins: DemoPlugins | null;
  /** Why your Plugins aren't in the demo, said once there; null when they are (or there are none). */
  problem: string | null;
  /** Stops the demo's Plugins and throws their files away. */
  close(): Promise<void>;
}

/** The fake Backend over the demo's Hosts, loaded when a tutorial starts. Your Plugins come along
 * (ticket 66, decision Q123): `real`'s demo Plugin host runs `plugins` (the ones running in your
 * workspace) against the demo's Hosts, offline, with throwaway files; their Packages are the
 * clones you have, never fetched. If `real` has no demo host, or it can't start one, the demo has
 * only its built-in Plugins, and `problem` says why. */
export async function demoBackend(real?: Backend, plugins?: DemoPlugins): Promise<Demo> {
  const { fakeBackend } = await import("../backend/fake");
  const hosts = demoHosts();
  const backend: Backend = fakeBackend({ hosts, vault: { status: "unsupported" } });
  const yours = plugins && plugins.installed.some((e) => !e.path.startsWith("builtin:")) ? plugins : null;
  const without = (problem: string | null): Demo => ({ backend, plugins: null, problem, close: async () => {} });
  if (!real?.demoPlugins) return without(yours ? "Your Plugins aren't in the demo: this roster can't run them there. The tutorial runs with roster's own." : null);
  let host;
  try {
    host = await real.demoPlugins(hosts);
  } catch (e) {
    return without(`Your Plugins aren't in the demo: ${e instanceof Error ? e.message : String(e)}. The tutorial runs with roster's own.`);
  }
  const { close, ...methods } = host;
  const packages = plugins?.packages ?? [];
  Object.assign(backend, methods, { packagesSync: async () => packages });
  return { backend, plugins: plugins ?? null, problem: null, close: () => close().catch(() => undefined) };
}

/** The State keys the demo starts from, so it looks like your app: the Theme and the hints. */
const LOOKS = [THEME_KEY, THEME_OVER_KEY, HINTS_KEY];

/** A Platform for the demo: a State in memory (seeded with how the app looks and, when the demo
 * can run them, the Plugins you run; never saved), and from `real` only the window, the
 * clipboard, fonts and init.lua. No folders.yml (the demo's Folders Plugin keeps its Folders in
 * the demo's throwaway files), no browser (its Hosts' addresses are made up), no fullscreen (Focus
 * in the demo leaves the window as it is), and `:config import-terminal` can't write. */
export function demoPlatform(real: Platform, looks: (key: string) => unknown, plugins?: DemoPlugins): Platform {
  const seed: Record<string, unknown> = Object.fromEntries(LOOKS.flatMap((k) => (looks(k) === undefined ? [] : [[k, looks(k)]])));
  // Your Plugins, with what each was granted (ticket 66): the demo's manager loads them from here.
  if (plugins) seed[PLUGINS_KEY] = plugins.installed;
  const config = real.config;
  return {
    loadState: async () => structuredClone(seed),
    saveState: async () => {},
    windowsBuild: () => real.windowsBuild(),
    clipboard: real.clipboard,
    ...(real.window ? { window: real.window } : {}),
    setFullscreen: async () => {},
    ...(real.fontInstalled ? { fontInstalled: real.fontInstalled } : {}),
    ...(config
      ? {
          config: {
            ...config,
            async importApply() {
              throw new Error("not on the demo Inventory: :tutor quit first");
            },
          },
        }
      : {}),
  };
}
