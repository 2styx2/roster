// The first-party Plugins' manifests (plugins/NAME/roster-plugin.lua), read from the files the core
// reads, so the fake Backend's stand-ins (fakeMesh.ts, fakeTopology.ts, fakeDiscover.ts) never
// copy one. A manifest there is one flat `return { ... }` of strings, a number and a list of
// strings; this reads that form only.
import discover from "../../../plugins/discover/roster-plugin.lua?raw";
import mesh from "../../../plugins/mesh/roster-plugin.lua?raw";
import topology from "../../../plugins/topology/roster-plugin.lua?raw";
import type { FakePlugin } from "./fakePlugins";

type Manifest = FakePlugin["manifest"];

export function manifestOf(lua: string): Manifest {
  const code = lua.replace(/--[^\n]*/g, "");
  const text = (key: string) => {
    const m = new RegExp(`\\b${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(code);
    if (!m) throw new Error(`roster-plugin.lua has no ${key}`);
    return m[1]!.replace(/\\(.)/g, "$1");
  };
  const api = /\bapi\s*=\s*(\d+)/.exec(code)?.[1];
  const list = /\bpermissions\s*=\s*\{([^}]*)\}/.exec(code)?.[1] ?? "";
  return {
    name: text("name"),
    version: text("version"),
    description: text("description"),
    author: text("author"),
    api: Number(api),
    permissions: [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]!),
  };
}

export const FIRST_PARTY = {
  discover: manifestOf(discover),
  mesh: manifestOf(mesh),
  topology: manifestOf(topology),
} as const;
