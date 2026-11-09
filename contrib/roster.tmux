# roster.tmux: prefix+g ("go") opens the roster picker in a popup.
#
# UNSUPPORTED: an example, not part of roster and not tested.
# Load it from ~/.tmux.conf with:
#   source-file /path/to/roster.tmux
# The key is g because stock tmux leaves prefix+g unbound. For another key,
# change the g below. The popup starts in the current pane's directory, so a
# ./roster.yml there is found; Enter, ctrl-v and Tab then behave as in
# roster(1), and Tab marks several Hosts for synchronized panes.

bind-key g display-popup -E -w 80% -h 60% -d '#{pane_current_path}' roster
