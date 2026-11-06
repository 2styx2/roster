// Folders (GLOSSARY) is a Plugin built into roster (ticket 61, decision Q93): init.lua's Folders
// (and the ones to move in once, file.ts) are its settings, so a change to them loads it again.
import type { Platform } from "../platform/types";
import { foldersSettings } from "./file";
import type { FolderRegistry } from "./folders";

/** What the workspace tells a built-in Plugin of its own: its settings, and when they change. */
export interface BuiltinLink {
  name: string;
  settings(): Promise<Record<string, unknown>>;
  watch(changed: () => void): () => void;
}

export function foldersBuiltin(
  folders: FolderRegistry,
  file: Platform["folders"],
  state: { load(): Promise<void>; get(key: string): unknown },
): BuiltinLink {
  return {
    name: "folders",
    settings: () => foldersSettings(folders, file, state),
    watch: (changed) => folders.subscribe(changed),
  };
}
