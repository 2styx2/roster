// `@tauri-apps/api/core` in the full-stack build (vite.config.ts aliases it here): `invoke` and
// `Channel` over the bridge's WebSocket (roster-core shell/bridge.rs), so the app's own tauri.ts
// runs unchanged against the real core. The page is opened with `?bridge=<ws url with token>`.

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

interface Wire {
  id?: number;
  ok?: unknown;
  err?: unknown;
  event?: string;
  payload?: unknown;
  channel?: number;
  message?: unknown;
  bytes?: number[];
}

const pending = new Map<number, Pending>();
const channels = new Map<number, (m: unknown) => void>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const events: { event: string; payload: unknown }[] = [];
(globalThis as unknown as { e2eEvents: typeof events }).e2eEvents = events;
let nextId = 1;
let socket: Promise<WebSocket> | null = null;

function bridgeUrl(): string {
  const url = new URLSearchParams(globalThis.location.search).get("bridge");
  if (!url) throw new Error("the full-stack page needs ?bridge=<the bridge's URL>");
  return url;
}

function connect(): Promise<WebSocket> {
  socket ??= new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeUrl());
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("the bridge refused the connection"));
    ws.onclose = () => {
      for (const p of pending.values()) p.reject({ kind: "io", message: "the bridge closed" });
      pending.clear();
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      const m = JSON.parse(e.data) as Wire;
      if (m.event !== undefined) {
        // Every event in order, for a test to wait for (page.ts `events`).
        events.push({ event: m.event, payload: m.payload });
        for (const l of listeners.get(m.event) ?? []) l(m.payload);
      } else if (m.channel !== undefined) {
        // Raw bytes arrive as Tauri delivers them: an ArrayBuffer.
        const message = m.bytes ? new Uint8Array(m.bytes).buffer : m.message;
        channels.get(m.channel)?.(message);
      } else if (m.id !== undefined) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if ("err" in m) p?.reject(m.err);
        else p?.resolve(m.ok);
      }
    };
  });
  return socket;
}

export function isTauri(): boolean {
  return true;
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const ws = await connect();
  const id = nextId++;
  const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  ws.send(JSON.stringify({ id, cmd, args }));
  return result;
}

export class Channel<T = unknown> {
  readonly id: number;
  #onmessage: (m: T) => void = () => {};

  constructor() {
    this.id = nextId++;
    channels.set(this.id, (m) => this.#onmessage(m as T));
  }

  set onmessage(handler: (m: T) => void) {
    this.#onmessage = handler;
  }

  get onmessage(): (m: T) => void {
    return this.#onmessage;
  }

  toJSON(): { __channel: number } {
    return { __channel: this.id };
  }
}

/** For event.ts: a handler for every `event` the bridge sends; gives the stop function. */
export async function on(event: string, handler: (payload: unknown) => void): Promise<() => void> {
  await connect();
  const set = listeners.get(event) ?? new Set();
  listeners.set(event, set);
  set.add(handler);
  return () => void set.delete(handler);
}
