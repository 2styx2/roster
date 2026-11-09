# roster: build from source and install the binary, bash completion and man page.
#
#   make install                          # into ~/.local (no sudo)
#   sudo make install PREFIX=/usr/local   # for every user
#   make uninstall                        # the same PREFIX removes them again
PREFIX ?= $(HOME)/.local
BINDIR = $(DESTDIR)$(PREFIX)/bin
COMPDIR = $(DESTDIR)$(PREFIX)/share/bash-completion/completions
MANDIR = $(DESTDIR)$(PREFIX)/share/man/man1

all:
	cargo build --release --locked

install: all
	install -Dm755 target/release/roster $(BINDIR)/roster
	install -Dm644 contrib/roster.bash $(COMPDIR)/roster
	install -Dm644 roster.1 $(MANDIR)/roster.1
	@echo "installed roster into $(PREFIX); open a new shell for Tab completion"

uninstall:
	rm -f $(BINDIR)/roster $(COMPDIR)/roster $(MANDIR)/roster.1

.PHONY: all install uninstall
