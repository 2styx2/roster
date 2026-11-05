// The Inventory's path cut in its middle (round 18, round 19): its first folder and its file name
// stay ("~/…/roster.yml"), the folders between give way from their start. The status bar and the
// empty Inventory's pane draw it the same way; the box around it holds the whole path in `title`.
import { basePart, dirPart, headPart } from "./path";

export function PathText({ path }: { path: string }) {
  const head = headPart(path);
  return (
    <span className="path-text">
      <span className="path-head">{head}</span>
      <span className="path-dir">
        <span>{dirPart(path).slice(head.length)}</span>
      </span>
      <span className="path-base">{basePart(path)}</span>
    </span>
  );
}
