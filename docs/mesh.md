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
- The source needs its own Link to the jump Host (`ProxyJump` logs in to it first). Without one, the Link is `no-via`, left out, and `roster check` fails: `orion-3 has no Link to jump-1, its hop to db-9`. That Link must be written too: when this Box has no host key recorded for the jump Host, both are `no-host-key`, left out, and `roster check` fails (`roster setup --only jump-1` records it).
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
from="10.0.0.2",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… roster-mesh:orion-2
```

`from=` accepts the key only from the source's address, and the `roster-mesh:SOURCE` tag is how roster finds exactly its own lines again. Everything else in the file, including this Box's own `roster-managed` key, is never touched. Every file roster changes on a Host (`authorized_keys`, `~/.ssh/config`, `~/.claude/CLAUDE.md` and its own) is written to a new file beside it and moved into place, keeping the old one's mode, owner and SELinux label (`chcon --reference`, then `restorecon` where it exists), so a run cut short (a timeout, a dropped connection) leaves each file as it was or as it should be, never half written. A `~/ROSTER.md` that roster didn't write is left alone, with a warning.

**Idempotent.** The Mesh comes from `roster.yml` only, so applying it again, from this Box or any other, changes nothing and says `already in the mesh`.

**Links across networks are tested, not assumed.** A peer whose port the source can't reach is reported (`orion-3 can't reach 10.0.9.9:22`) and left out of that source's files and of the peer's `authorized_keys`. A peer whose host key this Box hasn't recorded is left out too (`roster setup --only PEER` records it). If the source has neither `nc` nor bash, the Link is written and shown as not tested. A source behind NAT reaches its peers from another address than the one in `roster.yml`, which `from=` refuses: give it a [`seen_as:`](#other-addresses) with that address, or give the Link a [`via:`](#through-a-jump-host) hop. `from=` also holds the address as `roster.yml` writes it: a DNS name matches only where sshd has `UseDNS yes`, so give meshed Hosts their addresses.

**Down Hosts.** A Host that doesn't answer is *pending*: everything else is applied, its Sources' keys stay on their peers as they were, and the next `roster mesh` finishes it. `roster mesh` and `roster mesh status` list what's pending until then. From the app, a run is a background job with no deadline: `mesh.stop` (the progress's stop button, `:cancel`) stops it before its next Host, and the Hosts it didn't get to are pending, `stopped`, until the next run. Quitting the app mid-apply stops it the same way, at once: the Host it was on and those it hadn't got to are pending, recorded on this Box, and the next run finishes them.

**Removing.** Taking a Host out of `roster.yml`, a Link, or `mesh: true` removes exactly its tagged entries on the next apply, and a Host that is no longer a source loses its Mesh files (the key, known hosts, config, the two `Include` lines, `ROSTER.md` and the import line). A Host taken out of `roster.yml` altogether can't be reached any more, so its own Mesh files stay there; `roster mesh` says so.

**Rotating.** `roster mesh --rotate HOST` makes a new key on HOST and replaces its line on every peer, in the same run. `--dry-run` shows it first.

`roster setup` applies the Mesh after setting up the Box when `roster.yml` has one (not with `--only`, since the Mesh covers every Host). `roster sync` says `mesh out of date` when `roster.yml` changed the Mesh since the last complete apply on this Box; nothing applies it by itself.

## Cut

`roster mesh cut HOST` takes HOST out of the Mesh **now**, without waiting for a Publish: on every Host at once (in parallel), HOST's key comes out of `authorized_keys`, every peer's key comes out of HOST's, and HOST's own Mesh files go. This Box's own access stays, so you can investigate; `roster revoke` is separate.

It then writes `mesh: false` for HOST in `roster.yml` as a Pending change, so the cut survives the next Publish. (When `roster.yml` isn't in a git repo, it's written straight to the file.)

Every Host is confirmed. One that's down or doesn't answer gets a loud warning, `CUT PENDING ON 2 HOSTS`, on every `roster mesh` run until the cut is finished there, by `roster mesh cut HOST` again or by the next `roster mesh`.

HOST's own Mesh files go from the directory its `mesh_dir:` names now, and from roster's own default directory. An earlier `mesh_dir:` that still holds a Mesh key (you changed or removed `mesh_dir:` since the last apply) is never removed: the cut ends with a warning naming it, so you can delete it by hand. `:mesh cut HOST` in the app shows the same warning (serve API 24).

## roster check

`roster check` (without `--only`) also checks the Mesh, read-only: whatever a `roster mesh` would change is **drift**, something on a Host that isn't what roster wrote, and is listed per Host (`nas-1: add key from orion-2`), in a [`mesh_dir:`](#esxi) too. Links that don't work (unreachable, no recorded host key, no Link to their hop) and pending Hosts make it fail too.

## ESXi

ESXi works as a source and as a peer, with everything kept where it survives a reboot:

- **As a peer**, keys go into `/etc/ssh/keys-USER/authorized_keys`, ESXi's own file, which it keeps across reboots. roster runs `/sbin/auto-backup.sh` after changing it, so it doesn't wait for the hourly backup. ESXi keeps a file under `/etc` only if it has the sticky bit, so when roster makes that file (a user other than root, whose `keys-USER` has none yet) it gives it mode `1600`, as ESXi's own; a rewrite keeps the mode the file has.
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

## Where it's kept on this Box

`~/.config/roster/mesh.json` (a named Inventory's: `mesh-NAME.json`, so two Inventories never share it; see [Named Inventories](cli-reference.md#named-inventories)) remembers what an apply or a cut couldn't finish (pending Hosts, cuts pending), the Hosts it wrote on, and what `roster.yml` looked like at the last complete apply (for `mesh out of date`). It's only bookkeeping: delete it and the next `roster mesh` still makes the Mesh what `roster.yml` says.
