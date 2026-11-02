// The fake Backend's Packages (ticket 24): what roster-core's package module does, for UI tests and
// the plain browser. A fake Package is a repo with versions (oldest first); "cloning" picks the
// commit roster.lock pins, else the newest, and loading `package:NAME` runs the fake Plugin of the
// version its clone is at, with init.lua's settings. Only the Packages listed in `named` (what
// init.lua names) are ever cloned, pinned or loaded, as in the core.
import type { FakePlugin } from "./fakePlugins";
import { BackendCallError, type PackageChecked, type PackageStatus, type PluginManifest } from "./types";

export interface FakePackageVersion {
  /** A full commit id (40 hex digits). */
  commit: string;
  subject: string;
  plugin: FakePlugin;
  /** What `git diff` would show from the version before. */
  diff: string;
}

export interface FakePackage {
  name: string;
  /** As init.lua writes it. */
  source: string;
  tag?: string;
  /** The folder in the repo (`plugins/topology`), as init.lua's `dir`. */
  dir?: string;
  config?: Record<string, unknown>;
  versions: FakePackageVersion[];
}

export interface FakePackages {
  /** What init.lua names: a test changes it (and the app syncs) as an edit to init.lua would. */
  named: FakePackage[];
  /** roster.lock, name → commit: kept here so a test can read it and start again from it. */
  lock: Record<string, string>;
  /** Repos that have been "fetched": a name not here has no clone. */
  clones?: Record<string, string>;
}

export const fakeCommit = (n: number) => n.toString(16).repeat(40).slice(0, 40);

export function fakePackageHost(
  scenario: FakePackages,
  describe: (m: FakePlugin["manifest"]) => PluginManifest,
): {
  /** The fake Plugin `package:NAME` is now, with its settings; undefined for anything else. */
  plugin(path: string): { plugin: FakePlugin; config: Record<string, unknown> } | undefined;
  packagesSync(): Promise<PackageStatus[]>;
  packagesPin(name: string): Promise<PackageStatus>;
  packagesDiscard(name: string): Promise<void>;
  packagesRemove(name: string): Promise<void>;
  packagesCheck(name?: string): Promise<PackageChecked[]>;
  packagesApply(name: string, commit: string): Promise<PackageStatus>;
  packagesClean(): Promise<string[]>;
} {
  const clones = (scenario.clones ??= {});
  const named = (name: string) => {
    const p = scenario.named.find((x) => x.name === name);
    if (!p) throw new BackendCallError(`init.lua names no Package ${name}`);
    return p;
  };
  const latest = (p: FakePackage) => p.versions[p.versions.length - 1] as FakePackageVersion;
  const status = (p: FakePackage): PackageStatus => {
    const commit = clones[p.name] ?? null;
    const locked = scenario.lock[p.name] ?? null;
    return {
      name: p.name,
      source: p.source,
      url: p.source.includes("://") || p.source.startsWith("/") ? p.source : `https://github.com/${p.source}.git`,
      dir: p.dir ?? null,
      wants: p.tag ? `tag ${p.tag}` : "default branch",
      commit,
      locked,
      pinned: commit !== null && commit === locked,
      config: p.config ?? {},
      note: null,
      error: null,
    };
  };

  // As the core: a new version whose manifest can't be used comes with why, and no manifest.
  const described = (m: FakePlugin["manifest"]): { manifest: PluginManifest | null; manifestError: string | null } => {
    try {
      return { manifest: describe(m), manifestError: null };
    } catch (e) {
      return { manifest: null, manifestError: e instanceof Error ? e.message : String(e) };
    }
  };

  return {
    plugin(path) {
      if (!path.startsWith("package:")) return undefined;
      const p = scenario.named.find((x) => x.name === path.slice("package:".length));
      const at = p && clones[p.name];
      const v = p?.versions.find((x) => x.commit === at);
      return p && v ? { plugin: v.plugin, config: p.config ?? {} } : undefined;
    },
    async packagesSync() {
      return scenario.named.map((p) => {
        clones[p.name] ??= scenario.lock[p.name] ?? latest(p).commit;
        return status(p);
      });
    },
    async packagesPin(name) {
      const p = named(name);
      const at = clones[name];
      if (!at) throw new BackendCallError(`the Package ${name} isn't fetched`);
      scenario.lock[name] = at;
      return status(p);
    },
    async packagesDiscard(name) {
      Reflect.deleteProperty(clones, name);
    },
    async packagesRemove(name) {
      Reflect.deleteProperty(clones, name);
      Reflect.deleteProperty(scenario.lock, name);
    },
    async packagesCheck(name) {
      if (name !== undefined && !clones[named(name).name]) throw new BackendCallError(`${name} isn't installed`);
      return scenario.named.flatMap((p): PackageChecked[] => {
        if (name !== undefined && p.name !== name) return [];
        const from = clones[p.name];
        if (!from) return [];
        const to = latest(p);
        if (to.commit === from) return [{ name: p.name, update: null, error: null }];
        const after = p.versions.slice(p.versions.findIndex((v) => v.commit === from) + 1);
        return [
          {
            name: p.name,
            error: null,
            update: {
              from,
              to: to.commit,
              log: after.map((v) => `${v.commit.slice(0, 7)} ${v.subject}`).reverse(),
              stat: ` init.lua | ${after.length} +\n 1 file changed`,
              diff: after.map((v) => v.diff).join("\n"),
              truncated: false,
              ...described(to.plugin.manifest),
            },
          },
        ];
      });
    },
    async packagesApply(name, commit) {
      const p = named(name);
      if (!p.versions.some((v) => v.commit === commit)) throw new BackendCallError(`${commit.slice(0, 7)} isn't in ${name}'s clone`);
      clones[name] = commit;
      scenario.lock[name] = commit;
      return status(p);
    },
    async packagesClean() {
      const keep = new Set(scenario.named.map((p) => p.name));
      const gone = [...new Set([...Object.keys(clones), ...Object.keys(scenario.lock)])].filter((n) => !keep.has(n)).sort();
      for (const n of gone) {
        Reflect.deleteProperty(clones, n);
        Reflect.deleteProperty(scenario.lock, n);
      }
      return gone;
    },
  };
}
