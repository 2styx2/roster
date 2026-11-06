// The State (GLOSSARY) while the app runs: one object outside React, read through
// useSyncExternalStore, saved to the State file after every change. Changes made before the file
// has been read are replayed over it once it has, and nothing is saved before that, so an early
// change never wipes what the file held. Any part of the app, or a Plugin, keeps its own key in
// it (Folders keeps `folders`); keys this version doesn't know are kept as they are.
import type { Platform } from "../platform/types";
import { emptyState, parseState, type AppState } from "./appState";

type Change = (state: AppState) => AppState;

export class StateStore {
  private state: AppState = emptyState;
  private loaded = false;
  private pending: Change[] = [];
  private saving: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly platform: Pick<Platform, "loadState" | "saveState">;

  constructor(platform: Pick<Platform, "loadState" | "saveState">) {
    this.platform = platform;
  }

  /** Reads the State file once; a file that can't be read starts empty. */
  async load(): Promise<void> {
    if (this.loaded) return;
    let json: unknown = {};
    try {
      json = await this.platform.loadState();
    } catch {
      // start empty
    }
    if (this.loaded) return;
    this.loaded = true;
    const early = this.pending;
    this.pending = [];
    this.state = early.reduce((s, change) => change(s), parseState(json));
    this.changed();
    if (early.length) this.save();
  }

  snapshot = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes the State and saves it. */
  update(change: Change) {
    const next = change(this.state);
    if (next === this.state) return;
    this.state = next;
    if (this.loaded) this.save();
    else this.pending.push(change);
    this.changed();
  }

  /** One key of the State, as it was saved (untrusted: parse it). */
  get(key: string): unknown {
    return this.state[key];
  }

  set(key: string, value: unknown) {
    this.update((s) => ({ ...s, [key]: value }));
  }

  private save() {
    const state = this.state;
    this.saving = this.saving.then(() => this.platform.saveState(state)).catch(() => {});
  }

  private changed() {
    for (const l of this.listeners) l();
  }
}
