-- Key bindings: roster.keymap.set(context, keys, action). The action is a command line.

roster.keymap.set("leader", "t", "next") -- Leader t: the next Session
roster.keymap.set("leader", "d d", false) -- unbind Leader d d
roster.keymap.set("global", "F12", "keys")
