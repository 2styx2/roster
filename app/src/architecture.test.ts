// @vitest-environment node
// The frontend's import rules (docs/architecture.md, "The frontend"), checked over the import lines
// of every module in src/. Type-only imports are erased by the compiler, so they don't count: a
// rule here is about what a module loads when it runs. Tests and test helpers may import anything.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const DOC = "docs/architecture.md";

/** The modules that wire features together: they may import any feature, and only wiring imports
 * them. backend/index.ts and backend/fixtureProps.ts pick the real or the fake Backend for main.tsx. */
const WIRING_FILES = ["App.tsx", "main.tsx", "registries.ts", "commands/builtins.ts", "backend/index.ts", "backend/fixtureProps.ts"];
const WIRING = (p: string) => WIRING_FILES.includes(p) || p.startsWith("app/") || p.startsWith("docs-site/");

/** The pure modules: data and rules with no component, so a test, the docs build or another
 * feature can load them alone. */
const PURE = ["sidebar/model.ts", "session/status.ts", "graph/model.ts", "ui/table.ts", "ui/when.ts", "backend/capabilities.ts", "panel/stack.ts", "ui/dot.ts", "view/segments.ts", "edit/diff.ts", "plugins/sessionEvents.ts"];

/** The folder imports that go up, each with why. Without them the folders depend one way: the test
 * fails on any other import that closes a cycle (of any length), and on an entry here that's gone
 * or no longer closes one (take it off: the list only shrinks). */
const KNOWN_BACK_EDGES: Record<string, string> = {
  "theme -> terminal":
    "terminal/options.ts holds the ANSI palette a Theme is made of (theme/theme.ts), and the terminal is drawn with the Theme (useTerminalEnv.ts)",
  "platform -> terminal": "the browser and Tauri Platforms probe fonts with terminal/fonts.ts; the terminal asks platform/os.ts",
  "plugins -> tutor": "plugins/opRegistry.ts applies every op kind into its feature (tutor's too); tutor/demo.ts loads the demo's Plugins",
};

/** A folder that holds two layers, split so the lower one counts on its own: the Config's data
 * (generated from the core; terminal/ and panel/ read it) under applying it (apply.ts). */
const CONFIG_DATA = ["config/core.gen.ts", "config/types.ts", "config/defaults.ts", "config/ranges.ts"];

/** The groups of NODES that reach each other through NEXT (Tarjan's strongly connected
 * components), each of more than one node, sorted. */
function stronglyConnected(nodes: string[], next: (v: string) => string[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const found: string[][] = [];
  let n = 0;
  const visit = (v: string) => {
    index.set(v, n);
    low.set(v, n++);
    stack.push(v);
    for (const w of next(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (stack.includes(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) found.push(scc.sort());
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return found;
}

interface Mod {
  path: string;
  /** What it loads: a relative import as a path under src/ (`ui/table.ts`), a package as written. */
  imports: string[];
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [p] : [];
  });
}

const isTest = (rel: string) => /\.test\.tsx?$/.test(rel) || /(^|\/)test-[^/]*\.tsx?$/.test(rel) || rel.startsWith("dev/");

// `import x from "m"`, `import { a } from "m"`, `import "m"`, `export { a } from "m"`; group 2 is
// `type` for an import the compiler erases.
const IMPORT = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function resolveImport(from: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  const base = resolve(dirname(from), spec.replace(/\?.*$/, ""));
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(p).isFile()) return relative(SRC, p).replaceAll("\\", "/");
    } catch {
      // not this spelling of it
    }
  }
  return relative(SRC, base).replaceAll("\\", "/");
}

function load(): Map<string, Mod> {
  const mods = new Map<string, Mod>();
  for (const file of files(SRC)) {
    const path = relative(SRC, file).replaceAll("\\", "/");
    if (isTest(path)) continue;
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports: string[] = [];
    for (const m of text.matchAll(IMPORT)) if (!m[2] && m[3]) imports.push(resolveImport(file, m[3]));
    for (const m of text.matchAll(DYNAMIC)) if (m[1]) imports.push(resolveImport(file, m[1]));
    mods.set(path, { path, imports });
  }
  return mods;
}

const MODS = load();

/** Every module PATH loads, itself included, each with the chain of imports that reached it. */
function reach(path: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[path, [path]]]);
  const queue = [path];
  while (queue.length) {
    const at = queue.shift()!;
    for (const next of MODS.get(at)?.imports ?? []) {
      if (seen.has(next)) continue;
      seen.set(next, [...seen.get(at)!, next]);
      if (MODS.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** The unit a module belongs to for the folder rule: its first folder under src/; the fake
 * Backend is an adapter of its own beside the real one; wiring and src/'s top are no unit. */
function unitOf(path: string): string | null {
  if (WIRING(path) || !path.includes("/")) return null;
  if (/^backend\/(fake|worstCase)/.test(path)) return "backend (fakes)";
  if (CONFIG_DATA.includes(path)) return "config (data)";
  return path.slice(0, path.indexOf("/"));
}

describe("the frontend's import rules", () => {
  it("reads the modules it checks", () => {
    expect(MODS.size).toBeGreaterThan(200);
    expect(MODS.get("App.tsx")?.imports).toContain("app/useConnection.ts");
    expect(MODS.get("backend/types.ts")?.imports).not.toContain("config/core.gen.ts"); // type-only
  });

  it("keeps xterm.js and the PluginManager out of the docs site and :help's pages", () => {
    // npm run docs builds the website under Node, where xterm.js (and the PluginManager, which loads
    // it through the Sessions' output feed) can't load. terminal/'s data modules are fine.
    const forbidden = (p: string) => p.startsWith("@xterm/") || p === "plugins/manager.ts" || /^terminal\/.*\.tsx$/.test(p);
    const roots = [...MODS.keys()].filter((p) => p.startsWith("docs-site/") || p === "help/pages.ts" || p === "commands/builtins.ts");
    const broken = roots.flatMap((root) => [...reach(root)].filter(([p]) => forbidden(p)).map(([, chain]) => chain.join(" -> ")));
    expect(broken, `${DOC}, "The docs build runs under Node"`).toEqual([]);
  });

  it("keeps the pure modules free of components", () => {
    const broken: string[] = [];
    for (const root of PURE) {
      expect(MODS.has(root), `${root} is gone: update PURE here and ${DOC}`).toBe(true);
      for (const [p, chain] of reach(root)) if (p.endsWith(".tsx")) broken.push(chain.join(" -> "));
    }
    expect(broken, `${DOC}, "Pure modules and components": a pure module loads no .tsx`).toEqual([]);
  });

  it("lets only wiring import wiring", () => {
    const broken = [...MODS.values()].flatMap((m) =>
      WIRING(m.path) ? [] : m.imports.filter((p) => MODS.has(p) && WIRING(p)).map((p) => `${m.path} -> ${p}`),
    );
    expect(broken, `${DOC}, "The frontend": the wiring modules (WIRING_FILES, app/, docs-site/) import features; no feature imports them`).toEqual([]);
  });

  it("has no import cycle between modules", () => {
    const cycles = stronglyConnected([...MODS.keys()], (v) => MODS.get(v)!.imports.filter((w) => MODS.has(w))).map((scc) => scc.join(", "));
    expect(cycles, `${DOC}, "Dependencies between folders": modules import each other one way`).toEqual([]);
  });

  it("has no import cycle between feature folders but through the known back edges", () => {
    const edges = new Map<string, Map<string, string>>();
    for (const m of MODS.values()) {
      const from = unitOf(m.path);
      if (!from) continue;
      for (const to of m.imports) {
        const into = MODS.has(to) ? unitOf(to) : null;
        if (!into || into === from) continue;
        const out = edges.get(from) ?? new Map<string, string>();
        if (!out.has(into)) out.set(into, `${m.path} -> ${to}`);
        edges.set(from, out);
      }
    }
    const back = (a: string, b: string) => `${a} -> ${b}` in KNOWN_BACK_EDGES;
    const next = (a: string) => [...(edges.get(a)?.keys() ?? [])].filter((b) => !back(a, b));
    const cycles = stronglyConnected([...edges.keys()], next).map((scc) =>
      scc.flatMap((a) => next(a).filter((b) => scc.includes(b)).map((b) => `${a} -> ${b} (${edges.get(a)!.get(b)})`)).join("; "),
    );
    const reaches = (from: string, to: string) => {
      const seen = new Set([from]);
      const queue = [from];
      for (let at = queue.shift(); at !== undefined; at = queue.shift())
        for (const b of next(at)) {
          if (b === to) return true;
          if (!seen.has(b)) {
            seen.add(b);
            queue.push(b);
          }
        }
      return false;
    };
    const gone = Object.keys(KNOWN_BACK_EDGES).filter((edge) => {
      const [a = "", b = ""] = edge.split(" -> ");
      return !edges.get(a)?.has(b) || !reaches(b, a);
    });
    expect(cycles, `${DOC}, "Dependencies between folders": feature folders depend one way`).toEqual([]);
    expect(gone, "these no longer close a cycle: take them off KNOWN_BACK_EDGES (and the doc's list)").toEqual([]);
  });
});
