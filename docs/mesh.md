# The Mesh: Hosts that reach each other

roster runs on one Box and sets up Host-to-Host access itself: Hosts in a meshed group, or joined by a Link, can `ssh` to each other with keys roster makes on them. Nothing is installed on the Hosts, and no password, vault or copy of roster ever reaches one. Each Host logs in to a peer as **that peer's** user from `roster.yml`.

The Mesh isn't a VPN: a VPN makes the network path, and the Mesh decides who may log in where over the network you already have. The two combine.

## Saying who reaches whom

`mesh: true` on a group lets its Hosts reach each other, both ways. It cascades like every other setting (`defaults` → group → Host), so `mesh: true` in `defaults` meshes every group, including ones `discover` adds later. `mesh: false` opts a group or a Host out, of its group's Mesh and of every Link. Unreviewed Hosts never join.

`links:` at the top of `roster.yml` add one-way reach across groups and networks, from a Host or group to a Host or group. `both: true` makes it two-way.

```yaml
groups:
  lab:
    mesh: true                      # every lab Host reaches every other lab Host
    hosts:
      orion-2: 10.0.0.2
      esx-02: { ip: 10.0.0.12, user: root }
      sw-1: { ip: 10.0.0.20, enroll: false, auth: prompt }
  storage:
    hosts:
      nas-1: 10.0.0.30

links:
  - { from: orion-2, to: storage }            # orion-2 reaches every storage Host
  - { from: lab, to: nas-1, both: true }      # and nas-1 reaches the lab back
```

A Windows Host (`os: windows`) is left out: see [Windows Hosts](#windows-hosts).

A Link that names something that isn't a Host or a group, links a name to itself, or has a key other than `from`, `to`, `both` and `via` stops `roster.yml` from loading, with the entry's number in the message. A name that is both a Host's and a group's is refused too.

### Through a jump Host

A source that reaches a peer only through another Host (NAT, a bastion, another network) says so with `via:` on the Link:

```yaml
links:
  - { from: orion-3, to: jump-1 }               # orion-3 reaches the jump Host itself
  - { from: orion-3, to: db-9, via: jump-1 }    # and db-9 through it
```

The source's ssh config gets `ProxyJump jump-1` in db-9's block, so `ssh db-9` goes through jump-1, and db-9's `authorized_keys` line says `from="<jump-1's address>"`: the address db-9 actually sees. `from=` uses jump-1's `ip:` from `roster.yml`; a jump Host with several addresses lists the others in [`seen_as:`](#other-addresses). `roster mesh --dry-run` shows the hop (`orion-3 -> db-9 via jump-1`), and the test runs through it: orion-3 tests jump-1's port, and jump-1 (roster logs in to it from this Box) tests db-9's.

- `via:` names one Host, never a group, and not either end of the Link. Two entries that send the same pair through different Hosts stop `roster.yml` from loading. With `both: true` the way back goes through the same Host.
- The source needs its own Link to the jump Host (`ProxyJump` logs in to it first). Without one, the Link is `no-via`, left out, and `roster check` fails: `orion-3 has no Link to jump-1, its hop to db-9`. That Link must be written too: when this Box has no host key recorded for the jump Host, both are `no-host-key`, left out, and `roster check` fails (`roster setup --host jump-1` records it).
- A `via:` Link wins over the same pair without a hop (from a meshed group, say). Where a group Link expands to the jump Host itself, that pair goes direct.
- A jump Host that doesn't answer leaves the Link pending, with the source's key on the peer kept as it was. A password jump Host (`enroll: false`) works for ssh, which asks for its password, but roster can't log in to test the hop, so the Link shows as not tested.
- Removing the Link, `via:` included, or a Cut, removes the peer's line as for any other Link. Adding or changing `via:` replaces the peer's line (its `from=` changes).

### Other addresses

A Host with more than one address (a jump Host with a leg on each network, a Host behind NAT) connects to some peers from an address other than its `ip:`, and the peer's `from=` would refuse it. `seen_as:` on that Host lists the others, one or a list, as addresses or networks:

```yaml
      jump-1: { ip: 10.0.5.1, seen_as: 10.0.9.1 }          # db-9 sees it as 10.0.9.1
      orion-3: { ip: 10.0.0.3, seen_as: [192.0.2.3, 10.0.8.0/24] }
```

Every peer's line for that Host's key, direct or through it as a hop, then says `from="10.0.5.1,10.0.9.1"`: its `ip:` and every `seen_as:` address. Each one is one more place the key is accepted from, so list only addresses the Host really connects from (its own, or the NAT address it's seen as), and a network only when the address isn't fixed. `seen_as:` goes on the Host itself, never on a group or `defaults` (an address belongs to one Host), and it takes only IP addresses or networks (`10.0.9.0/24`), or `roster.yml` doesn't load. Changing it puts the Mesh out of date, and the next `roster mesh` replaces the lines.

Editing `roster.yml` from roster keeps `links:` in step: renaming a Host or a group (`host.rename`, `group.rename` in the app) renames it in `links:` too, and removing a Host or deleting a group takes out the `links:` entries that name it, line and all (the next `roster mesh` removes what they gave). An entry in a one-line list (`links: [{ from: a, to: b }]`) can't be taken out that way: the edit is refused and says so, and you take it out by hand.

**Password peers.** A Host with `enroll: false` (switches, appliances) stays in the Mesh as a password peer: its peers get an ssh config entry for it, and ssh asks the person for the password. roster never copies a password to a Host, and the `ROSTER.md` there tells Claude to ask the user to log in. A password Host can't reach others: roster only logs in to it with a password, so it never writes files on it (`roster mesh` lists those Links as `skipped`).

## roster mesh

```sh
roster mesh --dry-run        # the plan: who reaches whom, what changes on which Host
roster mesh                  # apply it, one Host at a time
roster mesh --rotate esx-02  # replace esx-02's Mesh key everywhere
roster mesh status           # who reaches whom and what's unfinished, without connecting
roster mesh cut orion-2      # take orion-2 out of the Mesh now, everywhere
roster mesh cut --all        # every Mesh entry off every Host (before removing roster)
roster mesh leftovers # Mesh entries on the Hosts this roster.yml doesn't ask for (changes nothing)
roster mesh status --json    # the same as status, as JSON for scripts
roster mesh --dry-run --json # the plan, as JSON
```

See [Machine-readable output](cli-reference.md#machine-readable-output) for the JSON.

`roster mesh` connects to each Host it needs, through this Box's own key, **one connection at a time** (rate limiters). It runs in two passes:

1. On each source (a Host that reaches peers): makes its key there if it has none, reads the public half back, and tests from there whether each peer's ssh port answers (`nc -z`, else bash's `/dev/tcp`).
2. On every Host it visits: writes the source's files, and puts each source's public key in the peer's `authorized_keys`.

On a source it writes:

| What | Where (Linux) | What's in it |
|---|---|---|
| The Mesh key | `~/.ssh/roster-mesh/id_ed25519` | Made on the Host with `ssh-keygen`. The private key never leaves it |
| Known hosts | `~/.ssh/roster-mesh/known_hosts` | The peers' host keys as this Box recorded them, so ssh checks them strictly |
| ssh config | `~/.ssh/roster-mesh/config`, included from the top of `~/.ssh/config` | A `Host PEER` block per peer, so `ssh PEER` works |
| `ROSTER.md` | `~/ROSTER.md` | The Host's peers only, for Claude there; imported from `~/.claude/CLAUDE.md` (an `@~/ROSTER.md` line) when Claude is installed |

On a peer it adds one line per source to `authorized_keys`:

```text
from="10.0.0.2",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… roster-mesh:orion-2@laptop
```

`from=` accepts the key only from the source's address, and the `roster-mesh:SOURCE@BOX` tag is how roster finds exactly its own lines again. Everything else in the file, including this Box's own `roster-managed` key, is never touched. See [Whose Mesh it is](#whose-mesh-it-is) for the `@BOX`. Every file roster changes on a Host (`authorized_keys`, `~/.ssh/config`, `~/.claude/CLAUDE.md` and its own) is written to a new file beside it and moved into place, keeping the old one's mode, owner and SELinux label (`chcon --reference`, then `restorecon` where it exists), so a run cut short (a timeout, a dropped connection) leaves each file as it was or as it should be, never half written. A `~/ROSTER.md` that roster didn't write is left alone, with a warning.

**Idempotent.** The Mesh comes from `roster.yml` only, so applying it again from this Box changes nothing and says `already in the mesh`. Another Box with the same `roster.yml` adds its own lines once, beside this Box's (see [Whose Mesh it is](#whose-mesh-it-is)).

**Links across networks are tested, not assumed.** A peer whose port the source can't reach is reported (`orion-3 can't reach 10.0.9.9:22`) and left out of that source's files and of the peer's `authorized_keys`. A peer whose host key this Box hasn't recorded is left out too (`roster setup --host PEER` records it). If the source has neither `nc` nor bash, the Link is written and shown as not tested. A source behind NAT reaches its peers from another address than the one in `roster.yml`, which `from=` refuses: give it a [`seen_as:`](#other-addresses) with that address, or give the Link a [`via:`](#through-a-jump-host) hop. `from=` also holds the address as `roster.yml` writes it: a DNS name matches only where sshd has `UseDNS yes`, so give meshed Hosts their addresses.

**Down Hosts.** A Host that doesn't answer is *pending*: everything else is applied, its Sources' keys stay on their peers as they were, and the next `roster mesh` finishes it. `roster mesh` and `roster mesh status` list what's pending until then. From the app, a run is a background job with no deadline: `mesh.stop` (the progress's stop button, `:cancel`) stops it before its next Host, and the Hosts it didn't get to are pending, `stopped`, until the next run. Quitting the app mid-apply stops it the same way, at once: the Host it was on and those it hadn't got to are pending, recorded on this Box, and the next run finishes them.

**Removing.** Taking a Host out of `roster.yml`, a Link, or `mesh: true` removes exactly this Box's tagged entries for it on the next apply, and a Host that is no longer a source loses its Mesh files (the key, known hosts, config, the two `Include` lines, `ROSTER.md` and the import line). A Host taken out of `roster.yml` altogether can't be reached any more, so its own Mesh files stay there; `roster mesh` says so.

**Rotating.** `roster mesh --rotate HOST` makes a new key on HOST and replaces its line on every peer, in the same run. `--dry-run` shows it first.

`roster setup` applies the Mesh after setting up the Box when `roster.yml` has one (not with `--only`, since the Mesh covers every Host). `roster sync` says `mesh out of date` when `roster.yml` changed the Mesh since the last complete apply on this Box; nothing applies it by itself.

## Cut

`roster mesh cut HOST` takes HOST out of the Mesh **now**, without waiting for a Publish: on every Host at once (in parallel), HOST's key comes out of `authorized_keys`, every peer's key comes out of HOST's, and HOST's own Mesh files go. This Box's own access stays, so you can investigate; `roster revoke` is separate.

It then writes `mesh: false` for HOST in `roster.yml` as a Pending change, so the cut survives the next Publish. (When `roster.yml` is a plain file, not in a team repo, it's saved straight to the file: [A plain file or a team repo](cli-reference.md#a-plain-file-or-a-team-repo).)

Every Host is confirmed. One that's down or doesn't answer gets a loud warning, `CUT PENDING ON 2 HOSTS`, on every `roster mesh` run until the cut is finished there, by `roster mesh cut HOST` again or by the next `roster mesh`.

`roster mesh cut --all` takes this Box's whole Mesh off every Host `roster.yml` has that roster logs in to, at once: each of its `roster-mesh:` lines in each `authorized_keys`, and each source's Mesh files, as a cut does on the cut Host. It also takes the entries an older roster left with no Box in their tag (they may be another Box's or Inventory's, and its question says so); another Box's or Inventory's tagged entries stay. With named Inventories, run it for each (`roster --inv NAME mesh cut --all`). It doesn't change `roster.yml` (it's for [uninstalling roster](#uninstalling-roster)), so the next `roster mesh` puts the Mesh back. A Host that doesn't answer is listed, the command exits 1, and running it again finishes it.

A cut takes this Box's lines (and an older roster's on a Host this Box's record says it wrote on, see [Whose Mesh it is](#whose-mesh-it-is)); another Box's line for HOST stays, and an older roster's line it can't prove is this Box's stays with a warning naming `roster mesh leftovers`.

HOST's own Mesh files go from the directory its `mesh_dir:` names now, and from roster's own default directory. An earlier `mesh_dir:` that still holds a Mesh key (you changed or removed `mesh_dir:` since the last apply) is never removed: the cut ends with a warning naming it, so you can delete it by hand. `:mesh cut HOST` in the app shows the same warning (serve API 24).

## roster check

`roster check` (without `--only`) also checks the Mesh, read-only: whatever a `roster mesh` would change is **drift**, something on a Host that isn't what roster wrote, and is listed per Host (`nas-1: add key from orion-2`), in a [`mesh_dir:`](#esxi) too. Links that don't work (unreachable, no recorded host key, no Link to their hop) and pending Hosts make it fail too.

## Windows Hosts

The Mesh's scripts are sh, so an `os: windows` Host is left out of it (code 160): it's never a source, a peer or a hop, and roster never logs in to it for the Mesh (`roster mesh`, `--dry-run`, `cut`, `cut --all`, `leftovers`, `check`). That isn't an error: a meshed group with a Windows Host in it meshes the others, a Link from or to one is skipped, and a Link `via:` one is skipped too (roster can't test the hop), so the pair is linked only if something else links it. `roster mesh --dry-run`, `roster mesh status` and `roster check` say so:

```text
left out: dc-01 ([160] os: windows: the Mesh's scripts are sh, which a Windows Host can't run, so it's left out (a Link or meshed group naming it isn't an error))
```

The Mesh never wrote anything on a Windows Host (sh isn't there), so nothing is left to take off one. `mesh.plan` and `mesh.status` give the same reason in `excluded`.

## Hosts with another key type

The Mesh's keys are Ed25519 for now, which a FIPS-mode Host refuses (and may not make). So a Host whose `key_type:` isn't `ed25519` ([FIPS Hosts](adding-hosts.md#fips-hosts)) is left out of the Mesh as a Windows Host is (note 200): never a source, a peer or a hop. A meshed group or a Link naming it isn't an error, and `roster mesh --dry-run`, `roster mesh status` and `roster check` list it under "left out":

```text
left out: fips-01 ([200] key_type: ecdsa: the Mesh's keys are Ed25519 only for now, which a FIPS-mode Host refuses, so it's left out (a Link or meshed group naming it isn't an error))
```

Reach it from the Box (`ssh fips-01`, with the key of its own type).

## ESXi

ESXi works as a source and as a peer, with everything kept where it survives a reboot:

- **As a peer**, keys go into `/etc/ssh/keys-USER/authorized_keys`, ESXi's own file, which it keeps across reboots. roster runs `/sbin/auto-backup.sh` after changing it, so it doesn't wait for the hourly backup. ESXi keeps a file under `/etc` only if it has the sticky bit, so when roster makes that file (a user other than root, whose `keys-USER` has none yet) it gives it mode `1600`, as ESXi's own; a rewrite keeps the mode the file has. USER is the Host's `user:` in roster.yml, and it has to be the login as ESXi names it (`id -un` there: the same case, a directory account's form): sshd reads the folder of that name. When it isn't, the Mesh changes nothing on that Host, which stays pending with a line saying so ("this login is Root on ESXi, not root …"), until `user:` is set as the Host names it.
- **As a source**, ESXi's home and the rest of `/etc` are rebuilt from the boot image on every boot: a new file there doesn't survive. So the key, known hosts, config and `ROSTER.md` go in `.roster-mesh` on the first datastore (`/vmfs/volumes/<datastore>/.roster-mesh`, by its fixed id). The `Include` in `~/.ssh/config` is lost at a reboot: `ssh -F /vmfs/volumes/…/.roster-mesh/config PEER` always works, and `ROSTER.md` there says so. `roster check` reports the lost `Include` as drift, and `roster mesh` puts it back.

**`mesh_dir:`.** A source with no datastore roster would pick (only unnamed volumes, none writable), or one where you want the files elsewhere, names the directory itself:

```yaml
      esx-02: { ip: 10.0.0.12, user: root, mesh_dir: /vmfs/volumes/datastore2/roster-mesh }
```

It cascades like `mesh:` (`defaults` → group → Host; `mesh_dir: null` on a Host goes back to roster's pick), and it works on Linux too, in place of `~/.ssh/roster-mesh`. It must be an absolute path of letters, digits and `. _ - /` (it goes into ssh's config as it is), or `roster.yml` doesn't load. On the Host, roster checks it before writing anything, and leaves the Host pending with the reason when: on ESXi it isn't on a datastore (`/vmfs/volumes/<datastore>/…`), its parent isn't there, roster can't write there, or it already holds a `config`, `known_hosts`, `ROSTER.md` or `id_ed25519` that isn't roster's (give the Mesh a directory of its own; roster never touches those files, not even to remove them). Without `mesh_dir:`, nothing changes. Moving a source to a `mesh_dir:`, to another one, or back to roster's pick (removing `mesh_dir:`) makes a new key there (unless roster's pick still holds the key from before the `mesh_dir:`: roster uses that one again and warns, `orion-2: ~/.ssh/roster-mesh still holds an older Mesh key from before mesh_dir: changed, and roster uses it again: run roster mesh --rotate orion-2 to replace it`), replaces its line on every peer and its `Include` in `~/.ssh/config`; the old directory isn't removed, and `roster mesh` warns about it (`esx-02: /vmfs/volumes/datastore2/roster-mesh holds an earlier Mesh key that roster no longer uses`) until you delete it by hand. That holds when the source also stops being one in the same edit (`mesh: false`, or its Links gone): roster goes by the directory the `Include` after its mark in `~/.ssh/config` names, the one in use until now, so an old `mesh_dir:` is warned about and kept, roster's own default directory (`~/.ssh/roster-mesh`, a datastore's `.roster-mesh`) is removed, and the `Include` goes either way. Moving a Host to another group keeps the `mesh_dir:` it had (roster writes it on the Host); a Host with none takes the new group's, as for `mesh:`.

## Appliances

Appliances that run Dropbear rather than OpenSSH ignore a whole `authorized_keys` line that has an option Dropbear doesn't know, and Dropbear doesn't list `from=`. Keep them `enroll: false`: they're password peers, which needs nothing on them.

## In the app

The roster app has no Mesh controls of its own (roster's core stays small): they're the Mesh controls Plugin, which roster's repo ships in [`plugins/mesh`](../plugins/mesh/README.md). Name it in `init.lua`, then `:source`, and allow it when the app asks:

```lua
roster.packages.add({ "https://github.com/2styx2/roster", dir = "plugins/mesh" })
```

Then `:mesh` shows every Host in the Mesh with what it can reach, the status bar says **Mesh out of date** after a Publish that changed it, `:mesh plan` shows what an apply would change and `a` applies it after a question, and `:mesh cut HOST` cuts a Host once you've typed its name, with a warning for each Host that was down. Each Host's details (`:info HOST`) get a Mesh section with its reach. It runs everything through `roster serve` as background jobs (API 17) and follows them by the `job_progress` event (API 20), so it never polls; one connection at a time as `roster mesh` does, and asks before anything that changes a Host. `:help mesh-controls` once it's installed.

### Seeing the Mesh in Topology

To see who reaches whom as a map, add the Topology Plugin, [`plugins/topology`](../plugins/topology/README.md), the same way (`dir = "plugins/topology"`). `:topology` (`␣ T`) draws this Box, every Host by group and the Mesh:

- **A meshed group** is a cluster drawn as a mesh: its Hosts reach each other both ways. Its password peers (`enroll: false`) are a cluster of their own, "lab · password peers", with a dashed edge to them: they're reached, and reach no one, since roster doesn't write on a password Host. Its Hosts that aren't in the Mesh (unreviewed, `mesh: false`) are a third, "lab · not in the Mesh", with no Mesh edge at all.
- **Links** are edges: solid for a key, dashed for a password peer, an arrow one way. One edge stands for every Link from a group to a group (`{ from: lab, to: storage }`), or from a Host to a whole group. A Link with `via:` is labelled `via jump-1`, in the error colour when its source has no Link to the jump Host (`no-via`).
- **Out of date, pending and cut pending** are said above the map and marked on the Hosts: warn on a Host that didn't answer the last apply, error on a Host whose cut isn't finished, with a dotted, broken edge to each peer that may still hold its key.
- **The risk**: select a Host and the map lights up every Host it can reach, every hop away, and says how many: what its key reaches, and what those Hosts' own keys reach in turn, which is what someone who got onto it could reach. Its details (`:info HOST`) give the direct counts, the ones `roster mesh` reports ("Reaches 5 Hosts directly").

`x` on a Host cuts it, after you type its name, as `:mesh cut HOST` does. It asks `roster serve` for the Mesh with `mesh.status`'s `grouped` (API 19), which says a meshed group once instead of every pair in it, so 2,000 meshed Hosts stay quick to draw.

## Whose Mesh it is

Several Boxes can mesh the same Hosts: a team Box and your laptop that both list the NAS, or two named Inventories on one Box. Each one's Mesh is its own, because everything roster writes says whose it is:

- each `authorized_keys` line is tagged `roster-mesh:SOURCE@BOX`, where `BOX` is this Box as its own key's tag names it (`roster-managed:BOX`, from `box_name:` or the hostname), and `BOX/NAME` for a named Inventory (`roster-mesh:orion-2@laptop/home`);
- the Mesh's `config` and `ROSTER.md` on a source say it in their first line (`# Written by roster mesh for orion-2 (owner laptop) from roster.yml: …`), and a new Mesh key's comment is the line's tag.

**Give each Box its own name.** The owner is the name alone: two Boxes with the same `box_name:` (or, with it blank, the same hostname: `ubuntu`, `raspberrypi`, `localhost`, a cloned VM) are one owner, so each one's `roster mesh` takes the other's Mesh entries for its own, replacing and removing them, as each one's `roster setup` (when it installs its key on a Host) and `roster revoke` already take the other's `roster-managed` key. `roster check --box` warns when this Box's name is an OS image's default hostname (row 222); roster can't see another Box's name, so a name two Boxes share by chance isn't caught. To rename a Box that's already set up, set `box_name:` and run `roster setup`: it re-tags this Box's key on its Hosts where their key file holds it (`~/.ssh/authorized_keys`, ESXi's `/etc/ssh/keys-USER/authorized_keys`; matched by its public key, never another Box's line under the old name), and `roster revoke` finds the key under either name. Where another key's line already has the new name, setup stops on that Host (190) until you pick another name or run `roster setup --force`, after which that Box's line is this one's to replace or revoke. Lines you wrote by hand are yours to change ([new-box.md](new-box.md)). The Mesh follows a rename by itself (below).

`roster mesh`, a cut, `--rotate` and `mesh leftovers --remove` change and remove only this Box's (and Inventory's) entries. Another Box's lines, and a former source's Mesh files, `Include` and `ROSTER.md` that another Box wrote, stay as they are: a Box that lists a Host only as a peer never takes away the Mesh another Box set up from it.

A source Host has one Mesh directory, one key and one `config`, whoever meshes it. A second Box that makes the same Host a source uses its key as it is, puts its own lines on the peers, and never rewrites the other's files: when they say the same peers (the same `roster.yml`), nothing changes; when they say others, that Host is pending, `its Mesh files (…) are another Box's or Inventory's (laptop), and say other peers (config, …): roster leaves them alone`, and `--rotate` of that key is refused. Give the Links to the Box whose files they are.

That key stays the other owner's, and this Box still uses it: while the source is pending that way, this Box still writes its own lines for that key on its own peers, so the key is let in on Hosts the owner's files don't list. This Box can't take the key back: `--rotate` is refused here, and a cut here takes off only this Box's lines. Only the key's owner revokes it, by rotating it or cutting the Host on its Box (`roster mesh --rotate orion-2`, `roster mesh cut orion-2`): the key leaves the source, so this Box's Links from it stop too. This Box's own lines for the old key stay on its peers until its next `roster mesh` replaces them (their `from=` still lets the old key in from the source's address only), so when the key may have been copied, run `roster mesh` (or `roster mesh cut orion-2`) on this Box too. This Box's `roster check` (and `roster mesh --dry-run`) says so, per peer (row 243): `nas-1: this Box's line for orion-2's Mesh key is for a key orion-2 no longer has (…), and it still lets that key in (from=10.0.0.2) until this Box's next roster mesh replaces it`.

**Entries from an older roster** (from before roster put the Box in the tag) have no Box in their tag (`roster-mesh:orion-2`) or header. Their owner is unknown, so roster keeps them: apply, cut and rotate leave them, `roster mesh leftovers` lists them (`key from orion-2 (from=10.0.0.2), with no Box in its tag`), and only `mesh leftovers --remove` or `cut --all`, after their questions, remove them. The exception is a line this Box would write: on a Host its Mesh record names, its next `roster mesh` replaces an untagged line for a source it writes there with its own when that line is exactly the one it writes (the same key, `from=` and options, only without the Box in the tag; with `--rotate`, the line for the key being replaced counts too), and rewrites an untagged source directory it writes, so each Host changes once (`tag key from orion-2 as this Box's`) and `roster check` shows that as drift until then. Any other untagged line for that source (another `from=` or other options: another older Box's line, or this Box's from before an address changed) stays as it is, the apply warns about it (row 223), and `mesh leftovers` lists it beside this Box's own line. When it's another older Box's line for the key `--rotate` replaces, the warning says that key still gets in (from that line's `from=` address only) until the line is removed (`mesh leftovers --remove`) or that Box rotates too. Untagged Mesh files on a Host that isn't a source in this `roster.yml` are never removed that way (the record doesn't say which Box made it a source); `mesh leftovers` lists them. Changing `box_name:`, or naming the Inventory (`roster inv add`), changes the owner: the next `roster mesh` re-tags the entries the record says it wrote under the old one, the same way.

A roster older than v0.5.0 still running on another Box leaves tagged lines alone, but it still removes untagged lines, and Mesh files on a Host it doesn't make a source, as before. Upgrade the Boxes that share Hosts together, and straight to v0.5.1 or later: v0.5.0's first `roster mesh` took every untagged line for a source it writes on a Host its record names, another older Box's too. If a Box already ran v0.5.0's `roster mesh`, the other older Box's next `roster mesh` puts its line back; `roster mesh leftovers` on that Box lists the untagged lines that are still there.

## Where it's kept on this Box

`~/.config/roster/mesh.json` (a named Inventory's: `mesh-NAME.json`, so two Inventories never share it; see [Named Inventories](cli-reference.md#named-inventories)) remembers what an apply or a cut couldn't finish (pending Hosts, cuts pending), the Hosts it wrote on, the owner its entries carry (`owner`, [Whose Mesh it is](#whose-mesh-it-is)), and what `roster.yml` looked like at the last complete apply (for `mesh out of date`). It's only bookkeeping: delete it and the next `roster mesh` still makes the Mesh what `roster.yml` says (see [A Box with no Mesh record](#a-box-with-no-mesh-record)).

## roster installed or not

The Mesh needs nothing on a Host, so a Host without roster is the normal case. These are the cases where roster is, or was, installed somewhere.

### A Box with no Mesh record

A Box with no Mesh state at all (no `mesh.json` or `mesh-NAME.json`: a new Box, or roster removed and installed again without `roster mesh cut --all` first) doesn't know which Hosts hold Mesh entries, and `roster mesh status` says `no Mesh record on this Box`. `roster mesh`, `--dry-run`, `roster check` and `roster setup` work as they always do: they visit the Mesh's own Hosts only, where the same `roster.yml` finds its earlier keys and lines and keeps them as they are (nothing rewritten), and they never go looking anywhere else.

That's on purpose: entries an older roster wrote name only their source Host, not the Box or Inventory that wrote them, so a Box can't tell its own leftovers from another Box's Mesh, which is still in use. So looking further is a command you run:

```sh
roster mesh leftovers            # every Host, once, one at a time: what this roster.yml doesn't ask for; changes nothing
roster mesh leftovers --remove   # the same, then removes them after a question (-y doesn't ask)
```

```text
nas-1: key from orion-2 (from=10.0.0.2), with no Box in its tag
orion-2: Mesh key and files in /home/admin/.ssh/roster-mesh, the Include in ~/.ssh/config, /home/admin/ROSTER.md

Mesh entries this roster.yml doesn't ask for, on 2 Hosts. Those with no Box in their tag are an older roster's, which didn't say whose they are, so they may be another Box's or another Inventory's Mesh, still in use; the rest are this Box's own (their tag names it), from Links this roster.yml no longer has.
```

They're found by roster's own tag and mark, never by guessing: this Box's `roster-mesh:SOURCE@BOX` lines and untagged `roster-mesh:SOURCE` lines in `authorized_keys` (with their `from=` address, so you can tell whose they are), and, on a Host that isn't a source in this `roster.yml`, a Mesh key and files this Box or an older roster wrote, the two lines after roster's mark in `~/.ssh/config` and the Mesh's `ROSTER.md` (on a source, an older roster's only). Another Box's or Inventory's entries aren't listed: their tag says whose they are. Remove the untagged ones only when you know they're leftovers: the question says that another Box's Mesh stops working where it still used them. `mesh leftovers --remove` takes exactly what it found and nothing else (the Box's own `roster-managed` key and your lines stay), and, when untagged entries are among them, refuses while another Inventory's Mesh state is on this Box (one of its older lines would look the same). A Host that doesn't answer is listed, and the command exits 1.

### A Host that runs roster itself

A meshed Host can be a roster Box too. Both write its `~/.ssh/config`, each with its own lines and never the other's: the Mesh its mark and the `Include` of its config (above), the Host's own roster its `Include` of `~/.ssh/config.d/roster` (or, with named Inventories, `config.d/roster.inventories`). Each looks for its own line wherever it is, so neither adds it twice, moves the other's, or changes anything on a second run in either order. Their files are apart too: the Mesh's are in `~/.ssh/roster-mesh/` (or its `mesh_dir:`), the Host's roster's in `~/.ssh/config.d/`, `~/.ssh/roster-inventories/` and `~/.ssh/roster_known_hosts*`, and their keys have different tags (`roster-mesh:SOURCE@BOX`, `roster-managed:BOX`), so neither one's `revoke` or cut touches the other's. When both name the same Host, ssh takes each setting from the first `Include` that sets it, which is whichever was added last.

`ROSTER.md` is the one file they could share: the Mesh writes `~/ROSTER.md`, and the Host's roster writes `ROSTER.md` next to its `roster.yml`. When that `roster.yml` is in the home folder, neither writer overwrites the other's: `roster mesh` leaves the Host's roster's and warns (`orion-2: …/ROSTER.md is that Host's own roster's …`), and the Host's `roster sync` leaves the Mesh's and warns. Keep the Host's `roster.yml` in a folder of its own.

### A Host roster was removed from

roster removed from a Host leaves its files there: an `Include` of a `config.d/roster` that's gone, an old `ROSTER.md`, its known hosts. None of them stops the Mesh: ssh skips an `Include` of a file that isn't there, the Mesh's ssh config checks host keys against its own `known_hosts` only, and the Mesh's test is a port test (`nc -z`), not an ssh login. roster never deletes them (they're yours now); an old `~/ROSTER.md` of that roster's is warned about as above until you delete it.

The `Include` the Mesh relies on is checked: when `~/.ssh/config` includes the Mesh's config and that file isn't there (deleted by hand, a datastore gone), `roster mesh --dry-run` says so (`orion-2: ~/.ssh/config includes …/roster-mesh/config, which isn't there`), `roster check` lists it as drift, and `roster mesh` writes it again.

## Uninstalling roster

`./uninstall.sh` in the roster checkout does these steps in this order, then removes roster ([Removing a box](new-box.md#removing-a-box)). Before removing roster from this Box by hand, take off the Hosts what it put there, while it can still log in to them:

1. `roster mesh cut --all` (`roster --inv NAME mesh cut --all` for each named Inventory): this Box's Mesh keys, lines and files off every Host, and those an older roster left with no Box in their tag (they may be another Box's or Inventory's; the question says so). Run it again until it exits 0 (a Host that was down).
2. `roster revoke` (`roster revoke --all` with named Inventories): this Box's own key off every Host. It names this Box's files to delete once every Host has lost the key.
3. Delete those files, and roster.

Skipping step 1 leaves the Mesh working between the Hosts, with nothing on this Box that knows about it. Installed again with the same `roster.yml`, roster takes it as it is; to take it off then, run `roster mesh cut --all` from the new install, or `roster mesh leftovers` to see what a changed `roster.yml` no longer asks for ([A Box with no Mesh record](#a-box-with-no-mesh-record)).
