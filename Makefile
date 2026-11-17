# roster: build from source and install the binary, bash completion and man page.
#
#   make install                          # into ~/.local (no sudo)
#   sudo make install PREFIX=/usr/local   # for every user
#   make autocomplete                     # completion, sourced from ~/.bashrc
#   make uninstall                        # the same PREFIX removes them again
PREFIX ?= $(HOME)/.local
BASHRC ?= $(HOME)/.bashrc
BINDIR = $(DESTDIR)$(PREFIX)/bin
COMPDIR = $(DESTDIR)$(PREFIX)/share/bash-completion/completions
MANDIR = $(DESTDIR)$(PREFIX)/share/man/man1
# The one line `make autocomplete` adds to $(BASHRC), and uninstall removes.
SOURCE = [ -f $(PREFIX)/share/bash-completion/completions/roster ] && . $(PREFIX)/share/bash-completion/completions/roster \# roster completion

all:
	cargo build --release --locked

install: all
	install -Dm755 target/release/roster $(BINDIR)/roster
	install -Dm644 contrib/roster.bash $(COMPDIR)/roster
	install -Dm644 roster.1 $(MANDIR)/roster.1
	@echo "installed roster into $(PREFIX); open a new shell for Tab completion"

# Tab completion without relying on bash-completion finding it: install the
# file and source it from ~/.bashrc, once.
autocomplete:
	install -Dm644 contrib/roster.bash $(COMPDIR)/roster
	@touch $(BASHRC)
	@if grep -qxF '$(SOURCE)' $(BASHRC); then \
		echo "$(BASHRC) already sources the roster completion"; \
	else \
		printf '%s\n' '$(SOURCE)' >>$(BASHRC); \
		echo "added the roster completion to $(BASHRC); open a new shell or run: . $(BASHRC)"; \
	fi

uninstall:
	rm -f $(BINDIR)/roster $(COMPDIR)/roster $(MANDIR)/roster.1
	@if [ -f $(BASHRC) ] && grep -qxF '$(SOURCE)' $(BASHRC); then \
		grep -vxF '$(SOURCE)' $(BASHRC) >$(BASHRC).roster-tmp; \
		cat $(BASHRC).roster-tmp >$(BASHRC); rm -f $(BASHRC).roster-tmp; \
		echo "removed the roster completion from $(BASHRC)"; \
	fi

# What roster needs: system packages (apt, dnf or pacman) and the Bitwarden CLI.
deps:
	sh scripts/deps.sh

.PHONY: all install autocomplete uninstall deps
