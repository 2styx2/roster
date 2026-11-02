// Dev builds only (main.tsx never loads it in production): the "Demo data / Worst case" toggle
// from ticket 27. Each segment reloads the page with another `?fixture=`, so the data changes at
// the same boundary as in the tests (the fake Backend and the State it seeds), never in the
// components. It's chrome for the developer, not part of the design under test: small, plain,
// out of the way, and `?toggle=off` hides it for screenshots.
import { useState } from "react";

const SEGMENTS: [fixture: string, label: string][] = [
  ["many-hosts", "Demo data"],
  ["worst-case", "Worst case"],
  ["worst-case-empty", "Empty"],
  ["worst-case-one", "One"],
  ["worst-case-start", "Start error"],
  ["worst-case-vault", "Vault error"],
  ["recent-alerts", "Plugin"],
  ["discover", "Discover"],
  ["discover-worst", "Discover worst"],
];

const track: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: 34,
  transform: "translateX(-50%)",
  zIndex: 100,
  display: "flex",
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: "var(--line-strong)",
  font: "500 11px system-ui, sans-serif",
  boxShadow: "0 4px 16px var(--shadow)",
  opacity: 0.92,
};

const segment = (active: boolean): React.CSSProperties => ({
  height: 22,
  padding: "0 9px",
  border: 0,
  borderRadius: 6,
  font: "inherit",
  color: active ? "var(--text)" : "var(--muted)",
  background: active ? "var(--panel)" : "transparent",
  transition: "none",
});

export default function FixtureToggle() {
  const params = new URLSearchParams(location.search);
  const [hidden, setHidden] = useState(params.get("toggle") === "off");
  if (hidden) return null;
  const current = params.get("fixture") ?? "many-hosts";
  const pick = (fixture: string) => {
    params.set("fixture", fixture);
    location.assign(`?${params.toString()}`);
  };
  return (
    <div style={track} role="radiogroup" aria-label="Demo data (dev only)" data-dev-toggle>
      {SEGMENTS.map(([fixture, label]) => (
        <button
          key={fixture}
          type="button"
          role="radio"
          aria-checked={fixture === current}
          style={segment(fixture === current)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(fixture)}
        >
          {label}
        </button>
      ))}
      <button type="button" style={segment(false)} aria-label="Hide the toggle" title="Hide (until reload)" onClick={() => setHidden(true)}>
        ×
      </button>
    </div>
  );
}
