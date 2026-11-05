//! The `roster serve` methods the frontend may call as they are, through the app's one generic
//! call (`serve_call` in the Tauri shell, [`crate::backend::Backend::pass`]). The core adds nothing
//! to these: serve checks their params and answers. Every other method stays behind the core:
//!
//! - `session.prepare` and `quick.prepare` answer with an askpass token, and `session.fill` with a
//!   password (decision Q129): only the core reads them, to start or fill a Session's PTY;
//! - `host.trust_key` takes only a `SHA256:` fingerprint, which the core checks first;
//! - `host.check`, `host.check_job` and `jobs.stop` are the core's check job ([`crate::backend`]);
//! - `inventory.create` runs on a serve of its own, before there's a Backend;
//! - `inventory.info` is asked once, at start (`BackendInfo`).
//!
//! Plugins reach serve through their own permissions (plugin/permission.rs), not this list.

/// Each method passes as it is, with the frontend's params (a typed password or vault secret in
/// `vault.unlock`, `vault.login` and `host.add` goes to serve's stdin once and is wiped, rpc.rs).
pub const PASS_THROUGH: &[&str] = &[
    // The Inventory and its Hosts.
    "hosts.list",
    "host.get",
    "host.add",
    "host.update",
    "host.review",
    "host.verify_login",
    "host.scan_key",
    "box.check",
    "jobs.list",
    // The Live Inventory (ticket 28): removing, renaming and moving Hosts and groups, the watch.
    "host.remove",
    "host.rename",
    "host.move",
    "group.new",
    "group.rename",
    "group.delete",
    "inventory.reload",
    "inventory.watch",
    // Pending changes and the infra repo.
    "inventory.pull",
    "changes.diff",
    "changes.discard",
    "changes.publish",
    // Named Inventories (ticket 115).
    "inventories.list",
    "inventories.use",
    // The vault.
    "vault.status",
    "vault.unlock",
    "vault.login",
    "vault.lock",
    "vault.logout",
    "vault.configure",
    "vault.targets",
    "vault.item_fields",
    // "Save to vault" after a Session's own login (tickets 15, 16): ids and names only.
    "quick.save",
    "host.save_login",
    "vault.forget_typed",
];

/// `method` as it's listed, if the frontend may call it as it is.
pub fn passes(method: &str) -> Option<&'static str> {
    PASS_THROUGH.iter().copied().find(|m| *m == method)
}
