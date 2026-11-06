// `@tauri-apps/api/event` in the full-stack build: the shell's events (config-changed,
// config-stale, roster-notification, plugin-reply, plugin-demo-reply) from the bridge.
import { on } from "./core";

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

let nextId = 1;

export async function listen<T>(event: string, handler: (e: Event<T>) => void): Promise<() => void> {
  return on(event, (payload) => handler({ event, id: nextId++, payload: payload as T }));
}
