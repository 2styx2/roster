"""The commented example roster.yml written by `roster init`."""

EXAMPLE_CONFIG = """\
# roster.yml - the map of your network. NO PASSWORDS IN THIS FILE.
# Don't want to type IPs? Scan instead:  roster discover 10.0.1.0/24 --write
#   Found hosts land in a group with reviewed: false, which setup skips until you've checked them.
# Settings cascade: defaults -> group -> host (most specific wins).
#
# Naming: <product>-<role>-<nn>, e.g. orion-web-01, orion-db-01, net-sw-core-01.
#   Product first, so `roster hosts`, tab-completion (`ssh orion-<TAB>`) and
#   --only all line a product's boxes up together. Names are what you type, so
#   keep them short; put the human-friendly part in title / description.
#
# Identity fields (all optional, shown to you and to Claude):
#   title        short human name          "Orion - production web server"
#   description  what it is / what's on it, any length
#   type         what kind of box          dev, staging, prod, db, switch, router, firewall, ...
#   product      which product it belongs to
#   (type and product cascade from the group; a group's own title/description describe the group)
#
# auth = how setup gets the password the FIRST time, to install this box's SSH key.
#        After that the key is used and the password is never needed again
#        (except for hosts with enroll: false, which always log in by password).
#        The format is PROVIDER:WHAT. `roster vault status` lists every provider you have.
#   prompt                 ask once per group when you run setup
#   agent                  no password; an SSH key you already have (ssh-agent) gets in
#   env:VAR_NAME           an environment variable
#   bw:ITEM                Bitwarden item's login password (item name or id)
#   bw:ITEM#FIELD          ...or a custom field on it (also #username, #notes)
#   op:ITEM                1Password item's password (op:ITEM#FIELD, op:VAULT/ITEM#FIELD work too)
#   op:op://Vault/Item/f   ...or a full 1Password secret reference
#   cmd:COMMAND            any command that prints the password
#   YOURS:WHAT             any provider you add under `providers:` below or as a plugin
#
# user + auth are the box's DEFAULT login, for SSH and for every service on it. Override per service:
#   orion3:
#     ip: 10.19.1.211
#     user: admin                    # default login
#     auth: "bw:orion3 db"
#     ssh: { user: sshuser, auth: "bw:orion3 ssh" }     # SSH only (also takes port)
#     services:
#       https: { port: 443, user: webadmin, auth: "bw:orion3 web" }   # web UI with its own account
#       postgres: 5432               # short form: uses the default login
#   Long-form services also take url (derived from ip + port if missing), verify: false for
#   self-signed certificates, and login: basic|bearer|none for `roster web HOST [SERVICE] GET /path`
#   (also vsphere, unifi, openvpnas, hub; see docs/cli-reference.md).
#   ssh: and services: work in defaults and groups too.
#
# Bitwarden: run `bw login` once on the box (or set BW_CLIENTID / BW_CLIENTSECRET). A locked
#   vault is unlocked once per run (master password prompt, BW_PASSWORD, or existing BW_SESSION).
# 1Password: turn on the 1Password app integration, or set OP_SERVICE_ACCOUNT_TOKEN on
#   headless boxes, or `eval $(op signin)` first.

box_name: ""                 # name tagged on this box's key; blank = this machine's hostname
key_path: ~/.ssh/roster_ed25519
# key_type: ecdsa           # the SSH key type (default ed25519); also per group or host, e.g.
#                            # ecdsa for FIPS-mode hosts, which refuse ed25519
# key_max_age: 365d         # check --box warns once this Box's key is older (default 365d; off);
#                            # roster setup --rotate replaces it on every host
workers: 32                  # how many hosts to work on in parallel
claude_inline_limit: 60      # list hosts inside Claude's instructions up to this many
# web_login_names:           # your team's own names for roster's login types: login: appliance
#   appliance: hub           # on a service then works exactly like login: hub
# rate_limited: [10.0.0.0/8] # networks whose SSH rate limiter stops answering after many
#                            # connections: a Host there that doesn't answer is told so

providers:
  bw:
    sync: true               # pull the latest vault once per run before reading items
  op:
    vault: Infra             # default vault for op:ITEM references (optional)
    # account: my.1password.com   # if you're signed in to more than one account

  # Add any other tool with a command template - no code needed. {item} and {field} come
  # from auth: NAME:item#field (field defaults to default_field) and are shell-quoted for you.
  # vault:
  #   command: vault kv get -field={field} {item}       # auth: vault:secret/infra/web
  #   default_field: password
  #   help: HashiCorp Vault KV
  # keeper:
  #   command: keeper get {item} --format password      # auth: keeper:Orion servers
  #
  # Need login/unlock logic? Write a plugin: providers/<name>.py next to this file, or in
  # ~/.config/roster/providers/ (template: examples/providers/pass_store.py in the roster repo).
  # Extra plugin folders:  provider_dirs: [~/my-providers]

defaults:
  user: admin
  port: 22
  auth: prompt

groups:
  orion:
    title: Product Orion
    description: Customer-facing ordering app. Dev boxes are safe to break; prod is not.
    product: orion
    user: deploy
    auth: bw:Orion servers                # Bitwarden item named "Orion servers"
    hosts:
      orion-dev-01:
        ip: 10.0.1.15
        type: dev
        title: Orion - dev box (main)
        description: Shared dev environment; full stack in docker compose under /srv/orion.
        web: "https://10.0.1.15:8443"
      orion-web-01:
        ip: 10.0.1.20
        type: prod
        title: Orion - production web
        description: Nginx + API behind the load balancer. Ask before restarting anything.
        web: "https://10.0.1.20"
      orion-db-01:
        ip: 10.0.2.30
        port: 2222
        user: dbadmin
        auth: "bw:Orion servers#dbadmin"  # custom field "dbadmin" on the same item
        type: db
        title: Orion - Postgres primary
        services: { postgres: 5432 }
        description: Primary database. Read-only queries unless told otherwise.

  network:                   # switches/routers: no authorized_keys, so password login
    title: Network gear
    enroll: false
    user: netops
    auth: op:Network gear                  # 1Password item, in the default vault above
    hosts:
      net-sw-core-01:
        ip: 10.0.0.2
        type: switch
        title: Core switch, rack A
        description: Uplinks for the 10.0.1.0/24 and 10.0.2.0/24 VLANs.
        web: "https://10.0.0.2"
      net-rtr-edge-01:
        ip: 10.0.0.1
        type: router
        title: Edge router / internet gateway
        web: "https://10.0.0.1"

# The Mesh: Hosts that reach each other, set up from this box by `roster mesh` (docs/mesh.md).
#   mesh: true on a group (or defaults, or a host) lets its hosts ssh to each other with keys made on them;
#   mesh: false opts out. links: add one-way reach across groups (both: true for two-way).
#   Start small: try `roster mesh --dry-run` on two or three hosts first.
# links:
#   - { from: orion, to: net-sw-core-01 }

# Things with a secret but no address to connect to. Each type has a fixed set of fields:
#   every type   title, description, group (one of the groups above), user, auth
#   wifi         ssid (required), security (wpa2 | wpa3 | wpa | wep | open | wpa2-enterprise | wpa3-enterprise,
#                default wpa2), hidden (true/false)
#   account      url (required) - a website, portal or SaaS login
#   secret       nothing extra - an API key, license key, PSK
# `roster hosts --resources` lists them, `roster vault reveal NAME` prints the secret for a person to use.
resources:
  office-wifi:
    type: wifi
    ssid: Orion-Office
    auth: "bw:Office Wi-Fi"
    group: network
    title: Office Wi-Fi
  registrar:
    type: account
    url: https://dash.example-registrar.com
    user: it@example.com
    auth: "op:Domain registrar"
    title: Domain registrar (orion.example)
"""
