// The Config's defaults exactly as the core sends them: `Config::default()`, written out to
// crates/roster-core/tests/fixtures/config-defaults.json and held current by a Rust test. The app
// uses them until init.lua has loaded, and the docs site documents them.
import defaults from "../../../crates/roster-core/tests/fixtures/config-defaults.json";
import type { Config } from "./types";

// A JSON import types each string as `string`, which a union option (`renderer`) doesn't take:
// the cast narrows them, and the Rust test checks the values.
export const defaultConfig: Config = defaults.config as Config;
