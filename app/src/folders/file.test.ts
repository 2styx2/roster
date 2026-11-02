import { describe, expect, it } from "vitest";
import { parseFoldersYml } from "./file";

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
