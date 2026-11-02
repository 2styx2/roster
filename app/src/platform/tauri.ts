// The Platform inside Tauri: the State file, the Config and the Windows build come from src-tauri
// (roster-core state.rs, config/, platform.rs); the window's controls from Tauri's window API (tauriWindow.ts); the
// clipboard from the clipboard-manager plugin, because WebView2 won't let the page read the
// clipboard itself.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ConfigOpened, ConfigReport, ImportPreview } from "../config/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { tauriWindow } from "./tauriWindow";
import { canvasProbe } from "../terminal/fonts";
import type { Platform } from "./types";

export function tauriPlatform(): Platform {
  return {
    loadState: () => invoke<unknown>("state_load"),
    saveState: (state) => invoke("state_save", { state }),
    windowsBuild: async () => (await invoke<{ windowsBuild: number | null }>("platform_info")).windowsBuild,
    clipboard: {
      readText: async () => (await readText()) ?? "",
      writeText: (text) => writeText(text),
    },
    window: tauriWindow(),
    setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
    fontInstalled: canvasProbe(),
    // roster-core browser.rs checks it again (http or https, no user or password) and hands it
    // to the OS's default browser.
    openUrl: (url) => invoke("open_url", { url }),
    // roster-core config.rs: read at start, then a `config-changed` event after every save.
    config: {
      load: () => invoke<ConfigReport | null>("config_load"),
      watch(onChange) {
        const stop = listen<ConfigReport>("config-changed", (e) => onChange(e.payload));
        return () => void stop.then((f) => f());
      },
      watchStale(onStale) {
        const stop = listen("config-stale", () => onStale());
        return () => void stop.then((f) => f());
      },
      open: () => invoke<ConfigOpened>("config_open"),
      importPreview: () => invoke<ImportPreview>("config_import_preview"),
      importApply: async ({ base, result, date }) => {
        await invoke("config_import_apply", { previewed: { base, result, date } });
      },
      reload: () => invoke<ConfigReport | null>("config_reload"),
      writeTypes: () => invoke<string>("config_types"),
    },
    // roster-core config/folders.rs: read once at start, to move its Folders into the Folders
    // Plugin (ticket 61). The app never writes it now.
    folders: {
      read: () => invoke<{ path: string; text: string | null }>("folders_read"),
    },
  };
}
