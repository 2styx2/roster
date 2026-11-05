// What `:config` does in the workspace (config/command.ts names each), and `:config
// import-terminal`'s diff panel (ticket 33) with its write.
import type { Platform } from "../platform/types";
import { usePanelState, type PanelState } from "../panel/stack";
import type { ThemeChoice } from "../theme/picker";
import { errorText } from "../ui/format";
import { quiet, type Message } from "../ui/messages";
import type { FocusReturn } from "../ui/useFocusReturn";
import type { ConfigAction } from "./command";
import type { ConfigReport, ImportPreview } from "./types";

export interface Importing {
  preview: ImportPreview;
  problem: string | null;
  writing: boolean;
}

export interface ConfigActions {
  run: Record<ConfigAction, () => void>;
  importing: PanelState<Importing>;
  /** The import panel's Write: into init.lua, then applied at once. */
  writeImport(): void;
}

export function useConfigActions(opts: {
  platform: Platform;
  report: ConfigReport | null;
  take(r: ConfigReport): void;
  themeChoice: ThemeChoice;
  focus: FocusReturn;
  say(m: Message): void;
  /** `:source init.lua`, which `:config reload` is (decision Q58). */
  source(): void;
}): ConfigActions {
  const { platform, report, say } = opts;
  const importing = usePanelState<Importing>(opts.focus);
  const withSource = (act: (source: NonNullable<Platform["config"]>) => void) => () => {
    const source = platform.config;
    if (!source) return say("There's no init.lua here: this window isn't the app (a plain browser)");
    act(source);
  };
  const run: Record<ConfigAction, () => void> = {
    open: withSource((source) =>
      source.open().then(
        ({ path, created }) =>
          say(
            created
              ? `Created ${path} with every option commented out. Uncomment one and save: it applies at once.`
              : quiet(`Opened ${path}`, `Opened ${path}. Saving it applies it.`),
          ),
        (e: unknown) => say(`Can't open init.lua: ${errorText(e)}`),
      ),
    ),
    reload: withSource(() => opts.source()),
    path: withSource(() => say(report ? `init.lua is at ${report.path}` : "init.lua hasn't been read yet")),
    "import-terminal": withSource((source) => {
      opts.focus.remember();
      source.importPreview().then(
        (preview) => importing.set({ preview, problem: null, writing: false }),
        (e: unknown) => say(`Can't import: ${errorText(e)}`),
      );
    }),
    types: withSource((source) =>
      source.writeTypes().then(
        (file) => say(`Wrote ${file}: init.lua's option types, for lua-language-server (:help options#editor-support)`),
        (e: unknown) => say(`Couldn't write the types: ${errorText(e)}`),
      ),
    ),
  };

  const writeImport = () => {
    const source = platform.config;
    const now = importing.value;
    if (!source || !now) return;
    importing.set({ ...now, writing: true, problem: null });
    const { base, result, date, theme: imported } = now.preview;
    source.importApply({ base, result, date }).then(
      () => {
        importing.close();
        say("Wrote Windows Terminal's profile into init.lua. Reloading it.");
        // Applied now, whether or not a save reloads by itself.
        source.reload().then(
          (r) => {
            if (r) opts.take(r);
            if (r?.error) return say("Wrote Windows Terminal's profile into init.lua, which now has an error: the last good Config is still in use");
            // Its Theme is chosen as `:theme` chooses one, over init.lua's `theme` as the file now
            // has it, never pinned there (decision Q69).
            let note = "";
            if (imported) {
              const c = r?.config;
              opts.themeChoice.setConfigTheme(c && c.theme !== "auto" ? c.theme : null, c?.lines.theme ?? null);
              note = opts.themeChoice.keep(imported);
            }
            say(`Wrote Windows Terminal's profile into init.lua, and applied it${note ? `. ${note}` : ""}`);
          },
          (e: unknown) => say(`Wrote Windows Terminal's profile into init.lua, but couldn't read it again: ${errorText(e)}. :source applies it`),
        );
      },
      (e: unknown) => importing.set({ ...now, writing: false, problem: errorText(e) }),
    );
  };
  return { run, importing, writeImport };
}
