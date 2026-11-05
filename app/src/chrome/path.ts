/** The folder a path starts with, separator and all, which the status bar keeps when it cuts the
 * Inventory's path in its middle ("~/…/roster.yml", round 18): "~/" in "~/infra/roster.yml",
 * "/home/" in "/home/x/roster.yml", "C:\" in "C:\infra\roster.yml". Empty when the path's folder
 * is only that (nothing between it and the file name to cut). */
export function headPart(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = cut < 0 ? "" : path.slice(0, cut + 1);
  const lead = (/^[/\\]/.test(dir) ? /^[/\\][^/\\]*[/\\]/ : /^[^/\\]*[/\\]/).exec(dir)?.[0] ?? "";
  return lead.length < dir.length ? lead : "";
}
