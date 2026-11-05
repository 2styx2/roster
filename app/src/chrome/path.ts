/** The folder a path starts with, separator and all, which a cut path keeps ("~/…/roster.yml"):
 * "~/" in "~/infra/roster.yml", "/home/" in "/home/x/roster.yml", "C:\" in "C:\infra\roster.yml".
 * Empty when the path's folder is only that (nothing between it and the file name to cut). */
export function headPart(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = cut < 0 ? "" : path.slice(0, cut + 1);
  const lead = (/^[/\\]/.test(dir) ? /^[/\\][^/\\]*[/\\]/ : /^[^/\\]*[/\\]/).exec(dir)?.[0] ?? "";
  return lead.length < dir.length ? lead : "";
}

/** A path's folder part with its last separator ("~/team/"). */
export function dirPart(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? "" : path.slice(0, i + 1);
}

/** A path's file name ("roster.yml"). */
export function basePart(path: string): string {
  return path.slice(dirPart(path).length);
}

/** The ways a path may be drawn, longest first (round 20): whole, then with whole folders after
 * its first one replaced by one "…/", the nearest the file name kept longest
 * ("~/…/infra/roster.yml", "~/…/roster.yml"), then "…/roster.yml". A folder name is never cut
 * inside (round 19's "~/…ventory/roster.yml"); each form is shorter than the one before it. */
export function pathCuts(path: string): string[] {
  const out = [path];
  const dir = dirPart(path);
  if (!dir) return out;
  const sep = dir.endsWith("\\") ? "\\" : "/";
  const head = headPart(path);
  const base = basePart(path);
  const folders = dir.slice(head.length).match(/[^/\\]*[/\\]/g) ?? [];
  const add = (form: string) => {
    const last = out[out.length - 1] ?? path;
    if ([...form].length < [...last].length) out.push(form);
  };
  if (head) for (let k = 1; k <= folders.length; k++) add(`${head}…${sep}${folders.slice(k).join("")}${base}`);
  add(`…${sep}${base}`);
  return out;
}
