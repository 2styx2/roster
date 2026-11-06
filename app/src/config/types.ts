// The Config (GLOSSARY: Config) as the Rust core sends it: init.lua's table, checked against the
// schema and laid over the defaults, camelCase. Its types are generated from the core's Rust types
// (crates/roster-core/src/config/schema.rs, the source of truth) into core.gen.ts, with the
// Windows Terminal import's; this file names them for the app. The frontend never runs Lua; it
// gets this object at start (`config_load`) and again after every save (`config-changed`).
// docs/app/config.md documents each option as it's written in init.lua.
import type { ConfigOpened, ConfigReport, ImportPreview, Previewed } from "./core.gen";

export type {
  Config,
  ConfigError,
  ConfigKey,
  ConfigLocation,
  ConfigOpened,
  ConfigReport,
  DeprecatedUse,
  DiffLine,
  ImportOverridden,
  ImportPreview,
  ModeConfig,
  PackageSpec,
  Previewed,
  ThemeDef,
  VaultConfig,
} from "./core.gen";

/** Where the app gets the Config: the core in Tauri; tests push their own. */
export interface ConfigSource {
  /** The Config as the app starts (null: no config dir, use the defaults). */
  load(): Promise<ConfigReport | null>;
  /** Calls `onChange` after every reload (a `:source`, or a save with `auto_reload`); returns stop. */
  watch(onChange: (report: ConfigReport) => void): () => void;
  /** Calls `onStale` when a Config file was saved but not reloaded (`auto_reload` off). */
  watchStale(onStale: () => void): () => void;
  /** `:config`: makes init.lua if there's none (never overwriting one), then opens it in the
   * Config's `editor`. Rejects with why it couldn't. */
  open(): Promise<ConfigOpened>;
  /** `:config import-terminal` (ticket 33): the diff it would make. Rejects with why it can't. */
  importPreview(): Promise<ImportPreview>;
  /** Writes exactly what the preview showed: refused (nothing written) if init.lua or Windows
   * Terminal's settings changed since, with a message to run the import again. */
  importApply(previewed: Previewed): Promise<void>;
  /** `:config types`: writes the option types (LuaCATS, for lua-language-server) as
   * `types/roster-config.lua` in the config folder; resolves to the file's path. */
  writeTypes(): Promise<string>;
  /** `:source`: reads init.lua again now (watchers get it too). */
  reload(): Promise<ConfigReport | null>;
}
