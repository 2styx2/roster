import { describe, expect, it } from "vitest";
import { addToFolder, parseFolders, renameFolder, splitName, type Folder } from "./folders";

const lab: Folder[] = [
  { name: "Lab ESXi", hosts: ["esxi-02", "esxi-01"] },
  { name: "Daily", hosts: ["orion3"] },
];

describe("Folders in State", () => {
  it("reads what the State file holds, dropping anything malformed or repeated", () => {
    expect(
      parseFolders([
        { name: "Lab ESXi", hosts: ["esxi-02", 3, "esxi-02"] },
        { name: "lab esxi", hosts: [] },
        { name: "", hosts: [] },
        "Daily",
        { name: "Daily" },
      ]),
    ).toEqual([
      { name: "Lab ESXi", hosts: ["esxi-02"] },
      { name: "Daily", hosts: [] },
    ]);
    expect(parseFolders({ folders: [] })).toEqual([]);
  });

  it("adding a Host to a Folder that doesn't exist yet creates it", () => {
    expect(addToFolder(lab, "hub2", "Lab HUB")).toEqual({
      folders: [...lab, { name: "Lab HUB", hosts: ["hub2"] }],
      message: "Added hub2 to Lab HUB",
    });
    expect(addToFolder(lab, "esxi-02", "lab esxi")).toEqual({ error: "esxi-02 is already in Lab ESXi" });
  });

  it("won't rename onto another Folder's name", () => {
    expect(renameFolder(lab, "Daily", "lab esxi")).toEqual({ error: "There's already a Folder named lab esxi" });
    expect(renameFolder(lab, "Daily", " Every day ")).toMatchObject({ folders: [lab[0], { name: "Every day" }] });
  });
});

describe("Folder names on the command line", () => {
  it("knows an existing name with spaces, or a quoted one, or else takes one word", () => {
    const names = lab.map((f) => f.name);
    expect(splitName("Lab ESXi Lab VMware", names)).toEqual(["Lab ESXi", "Lab VMware"]);
    expect(splitName('"New one" Other', names)).toEqual(["New one", "Other"]);
    expect(splitName("Daily Every day", names)).toEqual(["Daily", "Every day"]);
    expect(splitName("Nope Every day", names)).toEqual(["Nope", "Every day"]);
  });
});
