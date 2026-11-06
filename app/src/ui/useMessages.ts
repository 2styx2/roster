// The message line, as Neovim's (ticket 111, decision Q115): init.lua's `ui.messages`, else
// `:messages`'s choice in the State, else quiet (routine confirmations and tips don't show). Every
// message goes into `:messages`'s history too, quiet ones included, and the history is a view.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Latest } from "./latest";
import type { Registries } from "../registries";
import { lineAfter, logView, MessageLog, MessagesChoice, type Message } from "./messages";

export interface MessagesState {
  message: Message;
  say(m: Message): void;
  log: MessageLog;
  choice: MessagesChoice;
}

/** Takes a message somewhere else than the line (a Sidebar row's slip, round 20): true when it did;
 * `:messages` keeps it either way. */
export type MessageDivert = (m: Message) => boolean;

export function useMessages(
  registries: Registries,
  store: { get(key: string): unknown; set(key: string, value: unknown): void },
  configValue: Parameters<MessagesChoice["setConfig"]>[0],
  divert?: { get(): MessageDivert | null },
): MessagesState {
  const [message, setMessage] = useState<Message>("");
  const [log] = useState(() => new MessageLog());
  const [choice] = useState(() => new MessagesChoice(store));
  choice.setConfig(configValue);
  // A quiet message from the background (a Plugin's notice, roster's own unasked one) keeps a line
  // that shows, an error above all (decision Q162).
  const say = useCallback(
    (m: Message) => {
      if (!divert?.get()?.(m)) setMessage((now) => lineAfter(now, m, choice.all()));
      log.push(m);
    },
    [log, choice, divert],
  );
  // The new list goes in before the old one comes out, so an open `:messages` view stays open.
  const logged = useSyncExternalStore(log.subscribe, log.snapshot);
  const [view] = useState(() => new Latest<(() => void) | null>(null));
  useEffect(() => {
    const remove = registries.views.register(logView(logged));
    view.get()?.();
    view.set(remove);
  }, [registries, logged, view]);
  useEffect(
    () => () => {
      view.get()?.();
      view.set(null);
    },
    [registries, view],
  );
  return { message, say, log, choice };
}
