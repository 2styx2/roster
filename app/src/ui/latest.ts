// What code outside React (the Plugin manager, the pull gate, a command) calls back into: the
// workspace's latest handlers, set after each render, read when it calls.
import { useLayoutEffect, useState } from "react";

export class Latest<T> {
  constructor(private value: T) {}

  get = (): T => this.value;

  set(value: T) {
    this.value = value;
  }
}

/** A Latest holding `value` as of the last render. */
export function useLatest<T>(value: T): Latest<T> {
  const [latest] = useState(() => new Latest(value));
  useLayoutEffect(() => latest.set(value));
  return latest;
}
