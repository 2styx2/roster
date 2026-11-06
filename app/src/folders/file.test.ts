import { describe, expect, it } from "vitest";
import { foldersSettings, parseFoldersYml } from "./file";

const TEXT = `# my folders
Lab ESXi:
  - esxi-02   # the new one
  - esxi-01
# nights
Night shift: []
`;

// folders.yml is only read now, to move its Folders into the Folders Plugin once (ticket 61).
describe("folders.yml", () => {
  it("reads Folder names with their Hosts, in order", () => {
    expect(parseFoldersYml(TEXT)).toEqual({
      folders: [
        { name: "Lab ESXi", hosts: ["esxi-02", "esxi-01"] },
        { name: "Night shift", hosts: [] },
      ],
    });
    expect(parseFoldersYml("")).toEqual({ folders: [] });
    expect(parseFoldersYml("Empty:\n")).toEqual({ folders: [{ name: "Empty", hosts: [] }] });
  });

  it("says the line of what's wrong", () => {
    expect(parseFoldersYml("Lab:\n  - a\nNight: x: y\n")).toMatchObject({ error: { line: 3 } });
    expect(parseFoldersYml("Lab:\n  - a\nlab: []\n")).toEqual({ error: { line: 3, message: "there are two Folders named lab" } });
    expect(parseFoldersYml("Lab:\n  x: 1\n")).toMatchObject({ error: { line: 2 } });
    expect(parseFoldersYml("- a\n")).toMatchObject({ error: { line: 1 } });
  });
});

describe("what the Folders Plugin is handed to move in", () => {
  const fixed = { list: () => [] };
  const state = { load: () => Promise.resolve(), get: () => [{ name: "Old", hosts: ["esx-02"] }] };

  it("moves folders.yml's Folders in when there's one, else the State's", async () => {
    const file = { read: () => Promise.resolve({ path: "folders.yml", text: TEXT }) };
    expect(await foldersSettings(fixed, file, state)).toMatchObject({ import_from: "folders.yml", import: [{ name: "Lab ESXi" }, { name: "Night shift" }] });
    const none = { read: () => Promise.resolve({ path: "folders.yml", text: null }) };
    expect(await foldersSettings(fixed, none, state)).toMatchObject({ import_from: "the State", import: [{ name: "Old" }] });
  });

  it("moves nothing in when folders.yml can't be read, and says why", async () => {
    const file = { read: () => Promise.reject(new Error("permission denied")) };
    const out = await foldersSettings(fixed, file, state);
    expect(out.import).toBeUndefined();
    expect(out.import_error).toBe("folders.yml can't be read (permission denied): fix it and they move in at the next start");
  });
});
