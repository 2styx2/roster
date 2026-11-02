import { describe, expect, it } from "vitest";
import { memoryPlatform } from "../platform/memory";
import { usedHost } from "./appState";
import { StateStore } from "./store";

describe("The State store", () => {
  it("replays changes made before the file was read over it, and saves nothing before that", async () => {
    const platform = memoryPlatform({ state: { version: 1, recentHosts: ["a"], folders: [{ name: "Lab", hosts: [] }] } });
    const store = new StateStore(platform);
    store.update((s) => usedHost(s, "b"));
    expect(platform.saved()).toBeUndefined();
    await store.load();
    expect(store.snapshot()).toMatchObject({ recentHosts: ["b", "a"], folders: [{ name: "Lab" }], folded: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(platform.saved()).toEqual(store.snapshot());
  });

  it("keeps a key it doesn't know, and sets one for whoever owns it", async () => {
    const platform = memoryPlatform({ state: { version: 1, newer: 1 } });
    const store = new StateStore(platform);
    await store.load();
    store.set("folders", []);
    await new Promise((r) => setTimeout(r, 0));
    expect(platform.saved()).toMatchObject({ newer: 1, folders: [] });
  });

  it("moves a Folder folded before Folders became a Plugin (folder:NAME) to its new id (folders:NAME)", async () => {
    const platform = memoryPlatform({ state: { version: 1, folded: ["folder:Lab ESXi", "group:lab", "folders:Night", "folder:Night"] } });
    const store = new StateStore(platform);
    await store.load();
    expect(store.snapshot().folded).toEqual(["folders:Lab ESXi", "group:lab", "folders:Night"]);
  });
});
