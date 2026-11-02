-- A Theme of my own, and the one to use.

roster.themes.define("roster-ember", {
  label = "Roster ember",
  base = "roster-dark",
  colors = { accent = "#e0803a", accent_ink = "#f0a060" },
})
roster.o.theme = "roster-ember"

-- A function a newer app added: check that it's there first, so this Config still loads in an
-- older one (roster.version is the app's version, for the rare case a name alone can't tell).
if roster.themes.update then
  roster.themes.update("nord", { colors = { accent = "#88c0d0" } })
end
