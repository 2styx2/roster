// Find in the scrollback: Enter finds the next match up the scrollback, Shift+Enter the one below,
// Esc closes and goes back to the shell.
import { useEffect, useState } from "react";
import { CloseGlyph } from "../ui/CloseGlyph";

export interface SearchResults {
  /** -1 when the match limit was passed and the position isn't known. */
  index: number;
  count: number;
}

export interface SearchBarProps {
  results: SearchResults | null;
  /** `incremental`: the query changed, so keep the current match if it still fits. */
  onFind(query: string, direction: "next" | "previous", incremental: boolean): void;
  onClose(): void;
  /** What it opens with, found at once (a Plugin's line, ticket 78). */
  initial?: string;
}

function resultText(query: string, r: SearchResults | null): string {
  if (!query || !r) return "";
  if (r.count === 0) return "no matches";
  return r.index < 0 ? `${r.count}+ matches` : `${r.index + 1} of ${r.count}`;
}

export function SearchBar({ results, onFind, onClose, initial = "" }: SearchBarProps) {
  const [query, setQuery] = useState(initial);
  useEffect(() => {
    if (initial) onFind(initial, "previous", true);
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="term-search" role="search">
      <input
        aria-label="Find in scrollback"
        placeholder="Find"
        autoFocus
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onFind(e.target.value, "previous", true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            onFind(query, e.shiftKey ? "next" : "previous", false);
          }
        }}
      />
      <span className="term-search-count" role="status">
        {resultText(query, results)}
      </span>
      <button type="button" tabIndex={-1} aria-label="Previous match (up)" onClick={() => onFind(query, "previous", false)}>
        ↑
      </button>
      <button type="button" tabIndex={-1} aria-label="Next match (down)" onClick={() => onFind(query, "next", false)}>
        ↓
      </button>
      <button type="button" tabIndex={-1} aria-label="Close find" onClick={onClose}>
        <CloseGlyph />
      </button>
    </div>
  );
}
