import type { ReactNode } from "react";

/** roster's messages put commands in backticks: show those as code. */
export function withCode(message: string): ReactNode[] {
  return message.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}
