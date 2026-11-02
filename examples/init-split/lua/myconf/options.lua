-- Options, one roster.o line each (:help options has them all).

roster.o.terminal.size = "16pt"
-- A list has list functions: the default fonts stay after this one.
roster.o.terminal.font:prepend("Cascadia Mono")
roster.o.terminal.cursor_style = "bar"
roster.o.vim = false

-- A whole object at once replaces what it holds; fields left out keep their defaults.
roster.o.modes.focus = { sessionbar = "bottom", statusbar = false }

-- Per machine.
if roster.os == "windows" then
  roster.o.editor = "wsl" -- $EDITOR inside WSL, in a console window of its own
end

