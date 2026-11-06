// A Plugin action's `when` (tickets 77, 78): it applies only to the rows or nodes whose fields
// match, each key one of its values. The table's rows and the graph's nodes match the same way.

export type When = Readonly<Record<string, readonly (string | number)[]>>;

export function whenApplies(when: When | undefined, fields: object): boolean {
  if (!when) return true;
  const of = fields as Readonly<Record<string, unknown>>;
  return Object.entries(when).every(([k, values]) => {
    const v = of[k];
    return (typeof v === "string" || typeof v === "number") && values.some((x) => String(x) === String(v));
  });
}
