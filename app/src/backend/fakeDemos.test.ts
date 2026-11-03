// The dev pages' stand-in Plugins (`?fixture=plugin-views`, `plugin-graph` and their worst cases)
// answer each button with an info notice, a probe that the button ran ("would open 10.0.0.5").
// Since tickets 117/118 (decision Q126) a plain info notice is quiet unless `:messages all`, so
// each probe says `quiet = false` and still shows in a plain browser (issue #228).
import { describe, expect, it } from "vitest";
import { GRAPH_PATH, demoMapPlugin } from "./fakeGraph";
import { fakePluginHost, type FakePlugin } from "./fakePlugins";
import { VIEWS_PATH, demoScanPlugin } from "./fakeViews";

/** Every `{ handler: N }` in a reply's ops: the buttons, opens and runs a dev page can press. */
function handlers(v: unknown, out: number[] = []): number[] {
  if (Array.isArray(v)) for (const x of v) handlers(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.handler === "number" && Object.keys(o).length === 1) out.push(o.handler);
    else for (const x of Object.values(o)) handlers(x, out);
  }
  return out;
}

/** Each notice the Plugin's handlers send, pressed one by one, with the floats and questions they
 * open pressed too. */
async function probes(path: string, plugin: FakePlugin) {
  const host = fakePluginHost({ [path]: plugin }, () => []);
  const { manifest, reply } = await host.pluginLoad(path, []);
  const notices: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  const todo = handlers(reply.ops);
  while (todo.length) {
    const h = todo.shift() as number;
    if (seen.has(h)) continue;
    seen.add(h);
    const r = await host.pluginCall(manifest.name, h, { row: "10.0.0.5", host: "esx-02", node: "h1" });
    for (const op of r.ops as Record<string, unknown>[]) if (op.op === "notify") notices.push(op);
    todo.push(...handlers(r.ops));
  }
  return notices;
}

describe("the dev pages' stand-in Plugins", () => {
  it.each([
    ["plugin-views", VIEWS_PATH, demoScanPlugin()],
    ["plugin-views-worst", VIEWS_PATH, demoScanPlugin(true, 20)],
    ["plugin-graph", GRAPH_PATH, demoMapPlugin(20, 4)],
    ["plugin-graph-worst", GRAPH_PATH, demoMapPlugin(40, 4, true)],
  ])("%s: every probe notice shows, whatever ui.messages says", async (_, path, plugin) => {
    const notices = await probes(path, plugin);
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) expect(n, String(n.text)).toMatchObject({ level: "info", quiet: false });
  });
});
