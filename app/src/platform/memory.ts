// A Platform held in memory, for tests: a State file and a clipboard you can look at.
import type { ConfigReport, ImportPreview, Previewed } from "../config/types";
import type { Platform } from "./types";

export interface MemoryPlatform extends Platform {
  /** What was last saved to the State file (undefined if nothing was). */
  saved(): unknown;
  /** The clipboard's text. */
  clipboardText(): string;
  /** Whether the window is fullscreen now. */
  fullscreen(): boolean;
  /** Acts as the core reloading init.lua: the app gets `report` as a live change. */
  saveConfig(report: ConfigReport): void;
  /** Acts as a save of init.lua, as the core's watcher sees it (roster-core Loader::on_save):
   * applied at once if the Config in effect has `auto_reload`, else only noticed. */
  fileSaved(report: ConfigReport): void;
  /** Changes what's on disk with no save event; `:source` reads it. */
  writeConfig(report: ConfigReport): void;
  /** init.lua's text, or null while there's no file. */
  configFile(): string | null;
  /** The paths `:config` opened, in order. */
  opened(): string[];
  /** Makes the next `:config` fail with `message`. */
  failOpen(message: string): void;
  /** How many times `:config types` wrote the types. */
  typesWritten(): number;
  /** The next `:config types` fails with this. */
  failTypes(message: string): void;
  /** The `base` of each import written, in order. */
  imported(): Previewed[];
  /** Makes the next import preview fail with `message`. */
  failImport(message: string): void;
  /** folders.yml's text (null: no file), when the platform has one. */
  foldersFile(): string | null;
  /** Saves folders.yml as an editor would (nothing watches it now: it's only read at start). */
  editFolders(text: string): void;
  /** The URLs handed to the default browser, in order. */
  urlsOpened(): string[];
}

/** What the core writes the first time (roster-core config/editor.rs starter): commented out. */
const STARTER = "-- Made by the roster app's :config from its example (examples/init.lua).\n";

export function memoryPlatform(
  start: {
    state?: unknown;
    windowsBuild?: number | null;
    clipboard?: string;
    config?: ConfigReport;
    /** init.lua's text (default: no file). */
    configFile?: string | null;
    /** What `:config import-terminal` previews. */
    importPreview?: ImportPreview;
    /** folders.yml's text: give it (null: no file yet) for a platform with folders.yml (ticket
     * 28); leave it out and Folders stay in the State, as in a plain browser. */
    folders?: string | null;
  } = {},
): MemoryPlatform {
  let state = start.state ?? {};
  let config = start.config ?? null;
  const watchers = new Set<(r: ConfigReport) => void>();
  const staleWatchers = new Set<() => void>();
  /** The report in effect (the core's Loader::current). */
  let applied = config;
  let saved: unknown;
  let clip = start.clipboard ?? "";
  let full = false;
  let file = start.configFile ?? null;
  const opened: string[] = [];
  const urls: string[] = [];
  let openError: string | null = null;
  let typesError: string | null = null;
  let typesWritten = 0;
  let importError: string | null = null;
  const imported: Previewed[] = [];
  let foldersText = start.folders ?? null;
  const path = () => config?.path ?? "/home/you/.config/roster/init.lua";
  const emit = (report: ConfigReport) => {
    applied = report;
    for (const w of watchers) w(report);
  };
  return {
    loadState: async () => state,
    async saveState(s) {
      state = structuredClone(s);
      saved = state;
    },
    windowsBuild: async () => start.windowsBuild ?? null,
    clipboard: {
      readText: async () => clip,
      async writeText(text) {
        clip = text;
      },
    },
    async setFullscreen(on) {
      full = on;
    },
    fullscreen: () => full,
    config: {
      load: async () => config,
      watch(onChange) {
        watchers.add(onChange);
        return () => watchers.delete(onChange);
      },
      watchStale(onStale) {
        staleWatchers.add(onStale);
        return () => staleWatchers.delete(onStale);
      },
      async open() {
        if (openError !== null) {
          const message = openError;
          openError = null;
          throw new Error(message);
        }
        const created = file === null;
        if (created) file = STARTER;
        opened.push(path());
        return { path: path(), created };
      },
      async importPreview() {
        if (importError !== null) {
          const message = importError;
          importError = null;
          throw new Error(message);
        }
        if (!start.importPreview) throw new Error("no Windows Terminal settings.json found");
        return start.importPreview;
      },
      async writeTypes() {
        if (typesError !== null) {
          const message = typesError;
          typesError = null;
          throw new Error(message);
        }
        typesWritten += 1;
        return path().replace(/init\.lua$/, "types/roster-config.lua");
      },
      async importApply(previewed) {
        imported.push(previewed);
      },
      async reload() {
        if (config) emit(config);
        return config;
      },
    },
    saveConfig(report) {
      config = report;
      emit(report);
    },
    fileSaved(report) {
      config = report;
      if (applied?.config.autoReload) emit(report);
      else for (const w of staleWatchers) w();
    },
    writeConfig(report) {
      config = report;
    },
    ...(start.folders !== undefined
      ? { folders: { read: async () => ({ path: "/home/you/.config/roster/folders.yml", text: foldersText }) } }
      : {}),
    foldersFile: () => foldersText,
    editFolders(text) {
      foldersText = text;
    },
    configFile: () => file,
    opened: () => [...opened],
    typesWritten: () => typesWritten,
    async openUrl(url) {
      urls.push(url);
    },
    urlsOpened: () => [...urls],
    imported: () => [...imported],
    failImport(message) {
      importError = message;
    },
    failTypes(message) {
      typesError = message;
    },
    failOpen(message) {
      openError = message;
    },
    saved: () => saved,
    clipboardText: () => clip,
  };
}
