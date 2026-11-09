# roster.tmux: prefix+r opens the roster picker in a popup.
#
# UNSUPPORTED: an example, not part of roster and not tested.
# Load it from ~/.tmux.conf with:
#   source-file /path/to/roster.tmux
# The popup starts in the current pane's directory, so a ./roster.yml there
# is found; Enter, ctrl-v and Tab then behave as in roster(1).
# This replaces tmux's default prefix+r (refresh-client).

bind-key r display-popup -E -w 80% -h 60% -d '#{pane_current_path}' roster
