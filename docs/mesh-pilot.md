# The Mesh: research notes and the real-network pilot

The Mesh ([mesh.md](mesh.md)) is built and tested against stand-in Hosts only (`tests/fakes/ssh` with `FAKE_HOSTS`, `tests/test_mesh.py`): directories that stand for Linux and ESXi Hosts, with down Hosts, blocked ports and an ESXi reboot. Nothing in the test suite touches a real Host. This page holds what the design rests on, and the checklist for the first run on real Hosts.

## Research

| Question | Finding | Source |
|---|---|---|
| Which `authorized_keys` options does OpenSSH take? | `from="pattern-list"` (the source address must match), `no-agent-forwarding`, `no-X11-forwarding`, and the key's comment as the last field. ESXi's sshd is OpenSSH, so it takes them too | [sshd(8), AUTHORIZED_KEYS FILE FORMAT](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT) |
| And Dropbear (many appliances)? | `no-port-forwarding`, `no-agent-forwarding`, `no-X11-forwarding`, `no-pty`, `restrict`, `permitopen=`, `permitlisten=`, `command=`. `from=` isn't listed, and **a key with an option Dropbear doesn't know is ignored entirely** | [dropbear(8)](https://github.com/mkj/dropbear/blob/master/manpages/dropbear.8) |
| Where does ESXi read keys? | `/etc/ssh/keys-<user>/authorized_keys` (sshd's `AuthorizedKeysFile`), kept across reboots | VMware's ESXi security guide ("Upload an SSH Key"); [William Lam, persisting changes in ESXi](https://williamlam.com/2011/08/how-to-persist-configuration-changes-in.html) |
| Does a new file under ESXi's `/etc` or `/` survive a reboot? | No. ESXi runs from an in-memory filesystem rebuilt at boot; `/sbin/auto-backup.sh` (hourly, or run by hand) saves only the files the system marks for it, and a file can't be marked by hand. Datastores (`/vmfs/volumes/...`) are kept | [William Lam, persisting changes in ESXi](https://williamlam.com/2011/08/how-to-persist-configuration-changes-in.html) |

What follows from it:

- Appliances on Dropbear would silently ignore the Mesh's key line (it has `from=`), so they stay password peers (`enroll: false`).
- On ESXi, peer keys go in `/etc/ssh/keys-USER/authorized_keys` and roster runs `/sbin/auto-backup.sh` after a change. A source's key and files go on a datastore. ESXi's `~/.ssh/config` is lost at every reboot, so `roster check` reports it and `roster mesh` restores it; `ssh -F` with the datastore's config works meanwhile.
- These are from public documentation of older ESXi releases; the pilot confirms them on the versions in use (below).

## Pilot checklist

For the owner, on 2–3 owner-chosen Hosts (at least one Linux pair; ESXi only after the Linux pilot runs clean). Until it does, `mesh: true` stays out of `defaults:` and out of any large group in the real Inventory.

1. **Snapshot.** On each pilot Host, copy `~/.ssh/authorized_keys`, `~/.ssh/known_hosts`, `~/.ssh/config` (and `~/.claude/CLAUDE.md` if there is one) somewhere safe. On ESXi: `/etc/ssh/keys-root/authorized_keys`.
2. **Group them.** A pilot group with `mesh: true`, or explicit `links:` between the 2–3 Hosts. Make one of them a password peer (`enroll: false`).
3. **Dry run.** `roster mesh --dry-run`; review the plan before anything else: every Link, its status, and every change on every Host.
4. **Apply.** `roster mesh`. On each Host, `ssh PEER true` works for key peers and asks for a password for the password peer; `ROSTER.md` lists only that Host's peers.
5. **Only tagged entries.** Diff each Host's files against the snapshot: only `roster-mesh:`-tagged lines, the two `Include` lines, the `@~/ROSTER.md` line and the files under `~/.ssh/roster-mesh/` (or its `mesh_dir:`) are new.
6. **Re-apply.** `roster mesh` again says `already in the mesh` and changes nothing.
7. **Rotate.** `roster mesh --rotate HOST`; the old key no longer logs in, the new one does.
8. **Down Host.** Stop sshd on one pilot Host (or block it), run `roster mesh`: it's pending; start it again, run `roster mesh`: finished.
9. **Remove.** Take a Host out of the pilot group (or a Link out): its tagged entries go, nothing else changes.
10. **Cut.** `roster mesh cut HOST` with one peer down: the loud `cut pending` warning, then finished once that peer answers. The Box can still log in to HOST.
11. **Back to the snapshot.** Remove `mesh: true` and the Links, run `roster mesh`: each Host's files match the snapshot again.
12. **SELinux.** On an SELinux-enforcing Host (RHEL, Oracle Linux, Fedora): after `roster setup`, and again after a `roster mesh` apply, the Box's key login still works (`roster check HOST`), a Mesh peer's `ssh PEER true` works, and `ls -Z ~/.ssh/authorized_keys` still shows `ssh_home_t`. roster rewrites the file as a new one moved into place, then copies the old label (`chcon --reference`) and runs `restorecon`.
13. **ESXi (later stage).** Apply with ESXi as source and peer, reboot it, `roster check` (drift: the `Include`), `roster mesh` (restored), and confirm its key and `authorized_keys` lines survived. Also with a non-root ESXi user whose `/etc/ssh/keys-USER/authorized_keys` roster creates: `ls -l` shows `-rw------T` (mode `1600`, the sticky bit), and its Mesh line is still there after the reboot.
14. **`mesh_dir:` (ESXi).** On an ESXi source, set `mesh_dir: /vmfs/volumes/<datastore>/roster-mesh`, apply: the files are there, the old `.roster-mesh` is warned about (delete it by hand), peers get a replaced key. Reboot: they survive. A `mesh_dir:` off a datastore (`/opt/x`) leaves the Host pending with the reason, and nothing is written.
15. **`via:`.** A Link `{ from: A, to: C, via: B }` plus `{ from: A, to: B }`, where C only accepts A through B. `--dry-run` shows `A -> C via B`; after the apply, on A, `ssh C true` works through B, and C's `authorized_keys` line says `from="<B's address>"`. Check that this is the address C really logs for B (`/var/log/auth.log` or `journalctl -u sshd` on C); if B has several addresses, list the one C sees in B's `seen_as:` ([Other addresses](mesh.md#other-addresses)); C's line then says `from="<B's ip>,<seen_as>"`. Take `via:` off: C's line is replaced with A's own address.
16. **`seen_as:`.** A Host behind NAT with `seen_as: <its NAT address>`: the peer's line holds both, and `ssh PEER true` works from it.
17. **From the app.** With the Mesh controls Plugin: `:mesh plan`, apply, then `:mesh cut HOST` with one peer down; the result matches steps 4 and 10.
