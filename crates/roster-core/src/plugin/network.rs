//! The `network` permission (decision Q97): an HTTP client in roster-core that a Plugin reaches
//! only through `roster.http`, and only for the sites its manifest lists and the user granted
//! (`network:api.example.com`). The frontend never sees it: a request's answer comes back to the
//! Plugin's own Lua, and only the UI changes its callback makes reach the app.
//!
//! The rules, each enforced here and tested in `tests/network.rs`:
//!
//! - **Sites are matched exactly.** `api.example.com` is that name on port 443 over https and
//!   nothing else; `*.example.com` is any name under `example.com` (not `example.com` itself);
//!   `http://` before a site allows plain http to it (and only http); `:PORT` after it allows that
//!   port instead of the scheme's own. An IP address is a site of its own, never matched by a name.
//! - **Redirects** are followed (at most 5) only to a site the Plugin may reach, by the same rule.
//! - **Nothing private by name.** Every name is resolved here, and if any address it gives is on
//!   this computer or a private, link-local or otherwise non-public network, the request fails.
//!   The connection then goes to exactly the addresses that were checked, so a name can't be
//!   re-pointed between the check and the connection (DNS rebinding). Such an address is reached
//!   only when the manifest lists the address itself (`network:http://10.0.0.5:8080`).
//! - **Private sites** (`network:private:nas.lan`, decision Q116) reach only private-network
//!   addresses, and a name one lists is judged only by the private sites.
//! - **A pin** (`#sha256:FINGERPRINT`, Q116) trusts exactly one certificate for that one https
//!   site, on a client of its own that no redirect leads to or from.
//! - **The user's proxy** (`plugin_proxy`, Q116) carries requests to public names only, with no
//!   credentials; the proxy then resolves the name.
//! - **Counts**, per Plugin and site, for `:plugins`: never a path, query, header or body.
//! - **Nothing of roster's goes along**: no cookie jar, no proxy but the user's, no
//!   `Referer`, no retries, no credentials; only the headers the Plugin sets, minus the ones
//!   that steer the connection.
//! - **Caps:** a request body of 256 KB, a response body of 1 MB, 10 s to connect, 30 s in all,
//!   and 4 requests in flight per Plugin.
//! - **Async:** the request runs on the core's own network threads; the Plugin's function is
//!   called with the answer later, as a call of its own with a call's budget.

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{Client, Method, Url, redirect};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// The most a request's body may be.
pub const MAX_REQUEST_BODY: usize = 256 * 1024;
/// The most a response's body may be; a longer one fails the request.
pub const MAX_RESPONSE_BODY: usize = 1024 * 1024;
/// The longest a request may take in all, and the default.
pub const MAX_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest to wait for a connection.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How many requests one Plugin may have in flight.
pub const MAX_IN_FLIGHT: usize = 4;
/// How many redirects a request follows.
pub const MAX_REDIRECTS: usize = 5;
/// The most headers a request may set.
pub const MAX_HEADERS: usize = 50;
/// Headers a Plugin may not set: they steer the connection, not the request.
pub const FORBIDDEN_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "expect",
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
];
/// The methods a request may use.
pub const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/// One site a Plugin may reach, as `network:SITE` names it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Site {
    /// `private:` before it (decision Q116): a name that resolves inside the private network,
    /// and only there. Never an address or a wildcard.
    pub private: bool,
    /// Plain http (`http://` before it); else https only.
    pub http: bool,
    pub host: SiteHost,
    /// The one port; `None`: the scheme's own (443, or 80 for http).
    pub port: Option<u16>,
    /// `#sha256:HEX` after it (decision Q116): the one certificate trusted for this https site,
    /// in place of the OS's trust store.
    pub pin: Option<Pin>,
}

/// A certificate's SHA-256 fingerprint: the hash of its DER bytes, as browsers show it.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Pin(pub [u8; 32]);

impl Pin {
    /// 64 lower-case hex digits, no colons.
    fn parse(hex: &str) -> Option<Pin> {
        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
            out[i] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
        }
        Some(Pin(out))
    }

    /// The fingerprint of a certificate's DER bytes.
    pub fn of(der: &[u8]) -> Pin {
        let digest = ring::digest::digest(&ring::digest::SHA256, der);
        let mut out = [0u8; 32];
        out.copy_from_slice(digest.as_ref());
        Pin(out)
    }
}

impl fmt::Display for Pin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.iter().try_for_each(|b| write!(f, "{b:02x}"))
    }
}

impl fmt::Debug for Pin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "sha256:{self}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SiteHost {
    /// `api.example.com`: that name exactly.
    Name(String),
    /// `*.example.com` (kept as `example.com`): any name that ends in `.example.com`.
    Under(String),
    /// `10.0.0.5`, `[fd00::5]`: that address exactly.
    Ip(IpAddr),
}

fn is_label(l: &str) -> bool {
    !l.is_empty()
        && l.len() <= 63
        && !l.starts_with('-')
        && !l.ends_with('-')
        && l.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A domain name as a site writes it: lower case ASCII labels (punycode for others), at least two.
fn is_domain(s: &str) -> bool {
    let labels: Vec<&str> = s.split('.').collect();
    s.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| is_label(l))
        // The last label is a top-level domain, never all digits (that'd be an address).
        && !labels[labels.len() - 1].chars().all(|c| c.is_ascii_digit())
}

const SITE_HELP: &str = "a site is a domain such as api.example.com, *.example.com for the names under it, or an address such as 10.0.0.5; http:// before it allows plain http, :PORT after it another port; private: before a name keeps it inside your private network, and #sha256:FINGERPRINT after an https site trusts only that certificate";

impl Site {
    /// `api.example.com`, `*.example.com`, `http://10.0.0.5:8080`, `[fd00::5]:8443`.
    pub fn parse(text: &str) -> Result<Site, String> {
        let bad = |why: &str| Err(format!("\"network:{text}\": {why} ({SITE_HELP})"));
        let (private, rest) = match text.strip_prefix("private:") {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let (rest, pin) = match rest.split_once('#') {
            None => (rest, None),
            Some((site, pin)) => match pin.strip_prefix("sha256:").and_then(Pin::parse) {
                Some(pin) => (site, Some(pin)),
                None => {
                    return bad(
                        "a pin is #sha256: and the certificate's SHA-256 fingerprint as 64 lower-case hex digits, without colons",
                    );
                }
            },
        };
        let (http, rest) = match rest.strip_prefix("http://") {
            Some(rest) => (true, rest),
            None if rest.contains("://") => return bad("only http:// may come before a site; https is the default"),
            None => (false, rest),
        };
        if rest.is_empty() {
            return bad("which site?");
        }
        if rest.chars().any(|c| c.is_ascii_uppercase()) {
            return bad("write it in lower case");
        }
        if rest.contains(['/', '?', '#', '@', ' ']) {
            return bad("only a site, with no path, user or spaces");
        }
        // The host, then an optional port.
        let (host, port) = if let Some(after) = rest.strip_prefix('[') {
            let Some((addr, tail)) = after.split_once(']') else {
                return bad("an IPv6 address goes in [ ]");
            };
            let port = match tail {
                "" => None,
                t => match t.strip_prefix(':') {
                    Some(p) => Some(p),
                    None => return bad("only :PORT may follow ]"),
                },
            };
            let Ok(ip) = addr.parse::<Ipv6Addr>() else {
                return bad("that isn't an IPv6 address");
            };
            if ip.to_string() != addr {
                return bad(&format!("write the address as [{ip}]"));
            }
            (SiteHost::Ip(IpAddr::V6(ip)), port)
        } else {
            let (host, port) = match rest.split_once(':') {
                Some((h, p)) => (h, Some(p)),
                None => (rest, None),
            };
            let host = if let Ok(ip) = host.parse::<Ipv4Addr>() {
                if ip.to_string() != host {
                    return bad(&format!("write the address as {ip}"));
                }
                SiteHost::Ip(IpAddr::V4(ip))
            } else if let Some(under) = host.strip_prefix("*.") {
                if !is_domain(under) {
                    return bad("*. goes before a domain of two names or more, such as *.example.com");
                }
                SiteHost::Under(under.to_string())
            } else if host.contains('*') {
                return bad("a wildcard is only *. at the start");
            } else if is_domain(host) || (private && is_label(host) && !host.chars().all(|c| c.is_ascii_digit())) {
                // A name on the private network may be one label (`appliance`), as LANs name things.
                SiteHost::Name(host.to_string())
            } else if host.chars().all(|c| c.is_ascii_digit() || c == '.') {
                return bad("that isn't an IPv4 address");
            } else {
                return bad("that isn't a domain with a dot in it, such as api.example.com");
            };
            (host, port)
        };
        let port = match port {
            None => None,
            Some(p) => match p.parse::<u16>() {
                Ok(n) if n > 0 && n.to_string() == p => Some(n),
                _ => return bad("the port is a number from 1 to 65535"),
            },
        };
        if private {
            match &host {
                SiteHost::Ip(ip) => {
                    return bad(&format!(
                        "an address is a site of its own: write network:{}{}",
                        if http { "http://" } else { "" },
                        match ip {
                            IpAddr::V4(v4) => v4.to_string(),
                            IpAddr::V6(v6) => format!("[{v6}]"),
                        }
                    ));
                }
                SiteHost::Under(_) => return bad("private: names one site, never a wildcard"),
                SiteHost::Name(n) if n == "localhost" || n.ends_with(".localhost") => {
                    return bad("that's this computer, not your private network: list 127.0.0.1 if you mean it");
                }
                SiteHost::Name(_) => {}
            }
        }
        if pin.is_some() {
            if http {
                return bad("plain http has no certificate to pin");
            }
            if matches!(host, SiteHost::Under(_)) {
                return bad("a pin is for one site, never a wildcard");
            }
        }
        Ok(Site {
            private,
            http,
            host,
            port,
            pin,
        })
    }

    /// Whether `url` is on this site: its scheme, host and port.
    pub fn allows(&self, url: &Url) -> bool {
        let scheme = if self.http { "http" } else { "https" };
        if url.scheme() != scheme {
            return false;
        }
        if url.port_or_known_default() != Some(self.port.unwrap_or(if self.http { 80 } else { 443 })) {
            return false;
        }
        match (&self.host, url.host()) {
            (SiteHost::Name(name), Some(url::Host::Domain(d))) => d == name,
            (SiteHost::Under(under), Some(url::Host::Domain(d))) => d
                .strip_suffix(under.as_str())
                .is_some_and(|head| head.len() > 1 && head.ends_with('.')),
            (SiteHost::Ip(IpAddr::V4(ip)), Some(url::Host::Ipv4(a))) => *ip == a,
            (SiteHost::Ip(IpAddr::V6(ip)), Some(url::Host::Ipv6(a))) => *ip == a,
            _ => false,
        }
    }

    /// Why the install prompt flags it.
    pub fn risk(&self) -> String {
        let mut text = format!(
            "Can send data to {} and fetch from it: anything the Plugin can read (your Hosts, what your Sessions print) could leave this computer.",
            self.place()
        );
        if self.http {
            text.push_str(" Plain http: anyone on the way can read and change it.");
        }
        if let SiteHost::Ip(ip) = &self.host
            && !is_public(*ip)
        {
            text.push_str(" That address is on this computer or a private network.");
        }
        if self.private {
            text.push_str(" It reaches inside your private network: whatever your network's DNS says that name is there. roster lets it reach only a private address, never this computer or the internet.");
        }
        if let Some(pin) = &self.pin {
            text.push_str(&format!(
                " Trusts only the certificate whose SHA-256 starts {}, in place of the ones your computer trusts, for this site alone.",
                &pin.to_string()[..16]
            ));
        }
        text
    }

    /// The site as a person reads it: `api.example.com`, `any site under example.com`,
    /// `nas.lan on your private network, with a pinned certificate`.
    pub fn shown(&self) -> String {
        match self.pin {
            Some(_) => format!("{}, with a pinned certificate", self.place()),
            None => self.place(),
        }
    }

    /// Where it reaches, without the pin.
    fn place(&self) -> String {
        let bare = Site {
            private: false,
            pin: None,
            ..self.clone()
        };
        let text = match &self.host {
            SiteHost::Under(under) => format!(
                "any site under {under}{}{}",
                if self.http { " over plain http" } else { "" },
                self.port.map(|p| format!(" on port {p}")).unwrap_or_default()
            ),
            _ => bare.to_string(),
        };
        if self.private {
            format!("{text} on your private network")
        } else {
            text
        }
    }
}

impl fmt::Display for Site {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.private {
            f.write_str("private:")?;
        }
        if self.http {
            f.write_str("http://")?;
        }
        match &self.host {
            SiteHost::Name(n) => f.write_str(n)?,
            SiteHost::Under(u) => write!(f, "*.{u}")?,
            SiteHost::Ip(IpAddr::V4(ip)) => write!(f, "{ip}")?,
            SiteHost::Ip(IpAddr::V6(ip)) => write!(f, "[{ip}]")?,
        }
        if let Some(p) = self.port {
            write!(f, ":{p}")?;
        }
        if let Some(pin) = &self.pin {
            write!(f, "#sha256:{pin}")?;
        }
        Ok(())
    }
}

/// Whether `ip` is a public internet address: not this computer, a private or link-local
/// network, shared address space (CGNAT), multicast, documentation or reserved ranges, and not
/// an IPv6 address that carries one of those (mapped, compatible, 6to4, NAT64).
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            let embedded = |hi: u16, lo: u16| Ipv4Addr::from(((hi as u32) << 16) | lo as u32);
            // ::a.b.c.d (IPv4-compatible, deprecated) and 64:ff9b::/96 (NAT64) carry an IPv4 address.
            if s[..6] == [0; 6] && !(s[6] == 0 && s[7] <= 1) {
                return is_public_v4(embedded(s[6], s[7]));
            }
            if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                return is_public_v4(embedded(s[6], s[7]));
            }
            // 2002::/16 (6to4) carries one in its next 32 bits.
            if s[0] == 0x2002 {
                return is_public_v4(embedded(s[1], s[2]));
            }
            // Only global unicast (2000::/3), minus documentation (2001:db8::/32) and the IETF
            // protocol assignments (2001::/23: Teredo, benchmarking, ORCHID).
            (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && s[1] == 0x0db8) && !(s[0] == 0x2001 && s[1] < 0x0200)
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0                                    // "this network"
        || a == 10                              // private
        || a == 127                             // loopback
        || (a == 100 && (64..128).contains(&b)) // shared (CGNAT)
        || (a == 169 && b == 254)               // link-local
        || (a == 172 && (16..32).contains(&b))  // private
        || (a == 192 && b == 0 && c == 0)       // IETF protocol assignments
        || (a == 192 && b == 0 && c == 2)       // documentation
        || (a == 192 && b == 88 && c == 99)     // 6to4 relay
        || (a == 192 && b == 168)               // private
        || (a == 198 && (18..20).contains(&b))  // benchmarking
        || (a == 198 && b == 51 && c == 100)    // documentation
        || (a == 203 && b == 0 && c == 113)     // documentation
        || a >= 224) // multicast, reserved, broadcast
}

/// Whether `ip` is on a private network and nowhere else: 10/8, 172.16/12, 192.168/16, shared
/// address space (100.64/10, CGNAT and overlay VPNs) and IPv6 unique local (fc00::/7), or an
/// IPv4-mapped one of those. Never this computer, link-local (where cloud metadata lives),
/// multicast or a public address.
pub fn is_lan(ip: IpAddr) -> bool {
    let v4 = |ip: Ipv4Addr| {
        let [a, b, ..] = ip.octets();
        a == 10 || (a == 172 && (16..32).contains(&b)) || (a == 192 && b == 168) || (a == 100 && (64..128).contains(&b))
    };
    match ip {
        IpAddr::V4(ip) => v4(ip),
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(mapped) => v4(mapped),
            None => (ip.segments()[0] & 0xfe00) == 0xfc00,
        },
    }
}

/// The sites a request to `url` is judged by: a name a `private:` site lists is reached only
/// through the private sites, so no public site (a wildcard over it, another port) widens it.
fn judged_by<'a>(sites: &'a [Site], url: &Url) -> impl Iterator<Item = &'a Site> {
    let private = matches!(url.host(), Some(url::Host::Domain(d)) if is_private_name(sites, d));
    sites.iter().filter(move |s| s.private == private)
}

fn is_private_name(sites: &[Site], name: &str) -> bool {
    sites
        .iter()
        .any(|s| s.private && matches!(&s.host, SiteHost::Name(n) if n == name))
}

/// What one manifest's sites may not say together: a name both `private:` and not (which rule
/// would its lookup follow?), or one site twice with different pins (which certificate?).
pub fn check_together(sites: &[Site]) -> Result<(), String> {
    for (i, a) in sites.iter().enumerate() {
        for b in &sites[i + 1..] {
            if let (SiteHost::Name(x), SiteHost::Name(y)) = (&a.host, &b.host)
                && x == y
                && a.private != b.private
            {
                return Err(format!(
                    "\"network:{a}\" and \"network:{b}\": {x} is either a name on your private network (private:{x}) or a public one, not both"
                ));
            }
            let bare = |s: &Site| Site { pin: None, ..s.clone() };
            if a.pin != b.pin && bare(a) == bare(b) {
                let bare = bare(a);
                return Err(format!(
                    "\"network:{a}\" and \"network:{b}\": {bare} is one site, with one pin or none"
                ));
            }
        }
    }
    Ok(())
}

/// Whether any of `sites` allows `url`.
pub fn allowed(sites: &[Site], url: &Url) -> bool {
    site_for(sites, url).is_some()
}

/// The site that allows `url`: one naming its host exactly before a wildcard over it, since a
/// site's pin holds for that exact site.
pub fn site_for<'a>(sites: &'a [Site], url: &Url) -> Option<&'a Site> {
    let mut matching = judged_by(sites, url).filter(|s| s.allows(url));
    let first = matching.next()?;
    if !matches!(first.host, SiteHost::Under(_)) {
        return Some(first);
    }
    matching.find(|s| !matches!(s.host, SiteHost::Under(_))).or(Some(first))
}

/// Which addresses a name may lead to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Public addresses only: every site's name, unless it's listed `private:`.
    Public,
    /// Private-network addresses only ([`is_lan`]): a `private:` site's name.
    Private,
    /// The proxy the user set: wherever their own setting says.
    Proxy,
}

impl Mode {
    /// The rule for the name `host`, given the Plugin's `sites` and the user's proxy's name.
    pub fn of(sites: &[Site], host: &str, proxy: Option<&str>) -> Mode {
        if is_private_name(sites, host) {
            Mode::Private
        } else if proxy == Some(host) {
            Mode::Proxy
        } else {
            Mode::Public
        }
    }

    /// `addrs` if every one is allowed, else why not.
    pub fn admit(self, host: &str, addrs: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, String> {
        if addrs.is_empty() {
            return Err(format!("{host} has no address"));
        }
        let wrong = match self {
            Mode::Public => addrs.iter().find(|a| !is_public(a.ip())).map(|a| {
                format!(
                    "{host} is at {}, an address on this computer or a private network: a Plugin reaches one only when its manifest lists the address itself, or the name as private:{host}",
                    a.ip()
                )
            }),
            Mode::Private => addrs.iter().find(|a| !is_lan(a.ip())).map(|a| {
                format!(
                    "{host} is at {}, which isn't on your private network: a private: site reaches only private addresses, never this computer or the internet",
                    a.ip()
                )
            }),
            Mode::Proxy => None,
        };
        match wrong {
            Some(why) => Err(why),
            None => Ok(addrs),
        }
    }
}

/// Resolves a name and refuses it unless every address it gives is one its [`Mode`] allows; the
/// connection then goes only to the addresses checked here (no second lookup to re-point).
struct Checked {
    sites: Arc<Vec<Site>>,
    proxy: Option<String>,
}

impl Resolve for Checked {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let mode = Mode::of(&self.sites, &host, self.proxy.as_deref());
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| format!("couldn't look up {host}: {e}"))?
                .collect();
            let addrs = mode.admit(&host, addrs)?;
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// The user's proxy for Plugins' requests (`plugin_proxy` in init.lua, decision Q116): an
/// `http://HOST:PORT` address and nothing else, never credentials. A Plugin can't set or see it.
/// Only requests to public names go through it; a `private:` site and an address go direct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proxy {
    /// `http://HOST:PORT/`, as the URL parser writes it (it leaves out port 80).
    url: Url,
    /// The port as written, 80 too.
    port: u16,
}

impl Proxy {
    /// `http://HOST:PORT`: an http scheme, a host (a name, an IPv4 address or an IPv6 one in
    /// `[ ]`), and a port written out; no user or password, path, query or fragment. A trailing
    /// `/` is allowed, and the name is case-insensitive.
    pub fn parse(text: &str) -> Result<Proxy, String> {
        let bad = |why: &str| {
            Err(format!(
                "{why} (a proxy is http://HOST:PORT, such as http://10.0.0.5:3128)"
            ))
        };
        let Some(rest) = text.strip_prefix("http://") else {
            return bad("only an http:// proxy (https still goes through it end to end, as a tunnel)");
        };
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        if rest.contains('@') {
            // Never repeat what was written: it may hold a password.
            return bad("a proxy carries no user or password: roster never sends credentials to one");
        }
        if rest.contains(['/', '?', '#']) {
            return bad("only http://HOST:PORT, with no path or query");
        }
        // The port is what follows the last ':' outside [ ].
        let (host, port) = match rest.rfind(':') {
            Some(i) if !rest[i..].contains(']') => (&rest[..i], &rest[i + 1..]),
            _ => return bad("it needs its port: http://HOST:PORT"),
        };
        if host.is_empty() {
            return bad("which host?");
        }
        let port = match port.parse::<u16>() {
            Ok(n) if n > 0 && !port.starts_with('+') => n,
            _ => return bad("the port is a number from 1 to 65535"),
        };
        let Ok(url) = Url::parse(&format!("http://{host}:{port}/")) else {
            return bad("that isn't a host name or address");
        };
        if url.host().is_none() {
            return bad("which host?");
        }
        Ok(Proxy { url, port })
    }

    /// Whether a request to `url` goes through the proxy: only to a public name. An address and
    /// a `private:` site's name are on a network the proxy isn't for.
    pub fn carries(&self, sites: &[Site], url: &Url) -> bool {
        matches!(url.host(), Some(url::Host::Domain(d)) if !is_private_name(sites, d))
    }

    /// Its name, when it's given by one: the one name that may lead anywhere.
    fn name(&self) -> Option<String> {
        match self.url.host() {
            Some(url::Host::Domain(d)) => Some(d.to_string()),
            _ => None,
        }
    }
}

impl fmt::Display for Proxy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.url.host() {
            Some(host) => write!(f, "http://{host}:{}", self.port),
            None => f.write_str("http://"),
        }
    }
}

/// The one rule the proxy can't keep for us (decision Q116): a public name going through it is
/// looked up here first, and if this computer gets any address inside, the request is refused
/// exactly as without a proxy. Only a name this computer can't look up at all (a network where
/// only the proxy resolves names) goes on to the proxy unchecked.
pub fn proxied(host: &str, lookup: Result<Vec<SocketAddr>, String>) -> Result<(), String> {
    match lookup {
        Ok(addrs) if !addrs.is_empty() => Mode::Public.admit(host, addrs).map(|_| ()),
        _ => Ok(()),
    }
}

/// [`proxied`] for `host`, looking it up with the system's resolver (blocking).
fn proxied_lookup(host: &str) -> Result<(), String> {
    use std::net::ToSocketAddrs;
    proxied(
        host,
        (host, 0)
            .to_socket_addrs()
            .map(Iterator::collect)
            .map_err(|e| e.to_string()),
    )
}

/// One Plugin's proxy setting: handed over when it loads, and changed by the host when the
/// user's Config changes it (`PluginHost::set_proxy`). Its client reads it at each request and
/// starts its connections over when it changed; requests already going finish as they began.
#[derive(Debug, Default)]
pub struct ProxyCell(Mutex<Option<Proxy>>);

impl ProxyCell {
    pub fn new(proxy: Option<Proxy>) -> ProxyCell {
        ProxyCell(Mutex::new(proxy))
    }

    pub fn get(&self) -> Option<Proxy> {
        self.0.lock().expect("proxy setting").clone()
    }

    pub fn set(&self, proxy: Option<Proxy>) {
        *self.0.lock().expect("proxy setting") = proxy;
    }
}

/// What the host hands each Plugin's client: its proxy setting, and where its requests are counted.
#[derive(Clone, Default)]
pub struct Setup {
    pub proxy: Arc<ProxyCell>,
    pub log: Arc<Log>,
}

/// How a Plugin used one site, for `:plugins` (decision Q116): counts and a time, never a path,
/// a query, a header or a body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SiteCount {
    /// The site as its permission names it (`api.example.com`, `private:nas.lan`).
    pub site: String,
    /// Requests sent.
    pub requests: u64,
    /// Of those, the ones that got no answer (an HTTP error status is an answer).
    pub failed: u64,
    /// When the last one was sent, in milliseconds since 1970.
    pub last: u64,
}

/// One Plugin's [`SiteCount`]s, kept by the host across its reloads, for as long as the app runs.
#[derive(Debug, Default)]
pub struct Log(Mutex<BTreeMap<String, SiteCount>>);

impl Log {
    fn sent(&self, site: &Site) {
        let last = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let key = site.to_string();
        let mut counts = self.0.lock().expect("network log");
        let row = counts.entry(key.clone()).or_insert_with(|| SiteCount {
            site: key,
            requests: 0,
            failed: 0,
            last: 0,
        });
        row.requests += 1;
        row.last = last;
    }

    fn failed(&self, site: &Site) {
        if let Some(row) = self.0.lock().expect("network log").get_mut(&site.to_string()) {
            row.failed += 1;
        }
    }

    /// Every site used, in order.
    pub fn counts(&self) -> Vec<SiteCount> {
        self.0.lock().expect("network log").values().cloned().collect()
    }
}

/// The core's network threads, shared by every Plugin, started the first time one needs them.
fn runtime() -> Result<&'static tokio::runtime::Runtime, String> {
    static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("plugin-network")
                .enable_all()
                .build()
                .map_err(|e| format!("couldn't start the network threads: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// A request a Plugin asked for, checked.
#[derive(Debug)]
pub struct Request {
    pub method: Method,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
}

/// How a request ended: an answer (any status), or why there was none.
#[derive(Debug, Clone)]
pub enum Answer {
    Response {
        status: u16,
        /// Where it ended, after redirects.
        url: String,
        /// Lower-case names; a repeated header's values joined with ", ".
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    Failed(String),
}

/// One Plugin's client: its sites, its connections (never shared with another Plugin), and its
/// requests in flight.
pub struct Net {
    sites: Arc<Vec<Site>>,
    proxy: Arc<ProxyCell>,
    /// Built for the proxy setting they name; built again when it changes.
    clients: std::cell::RefCell<Clients>,
    in_flight: Arc<AtomicUsize>,
    /// The requests going: each one's task, whether it has been counted as done, and its site.
    tasks: std::cell::RefCell<Vec<Going>>,
    log: Arc<Log>,
    /// Never sends (`:tutor`'s demo, decision Q123): every check runs and the in-flight cap holds,
    /// but each request answers "not sent" instead of going out.
    offline: bool,
}

struct Going {
    task: tokio::task::AbortHandle,
    settled: Arc<std::sync::atomic::AtomicBool>,
    site: Site,
}

struct Clients {
    proxy: Option<Proxy>,
    /// For every site without a pin: the OS's trust store checks certificates.
    shared: Client,
    /// For each pinned site, a client of its own that trusts only its pin and never leaves it.
    pinned: Vec<(Site, Client)>,
}

impl Clients {
    fn new(sites: &Arc<Vec<Site>>, proxy: Option<Proxy>) -> Result<Clients, String> {
        let shared = build(sites, proxy.as_ref(), None)?;
        let pinned = sites
            .iter()
            .filter(|s| s.pin.is_some())
            .map(|s| Ok((s.clone(), build(sites, proxy.as_ref(), Some(s))?)))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Clients { proxy, shared, pinned })
    }

    /// The client for a request to `site`: its own if pinned, else the shared one.
    fn for_site(&self, site: &Site) -> Option<Client> {
        match site.pin {
            Some(_) => self.pinned.iter().find(|(s, _)| s == site).map(|(_, c)| c.clone()),
            None => Some(self.shared.clone()),
        }
    }
}

/// Which client a request belongs to: the shared one (`None`), or a pinned site's.
fn client_of<'a>(sites: &'a [Site], url: &Url) -> Option<&'a Site> {
    site_for(sites, url).filter(|s| s.pin.is_some())
}

impl Net {
    pub fn new(sites: Vec<Site>, setup: Setup) -> Result<Net, String> {
        let Setup { proxy, log } = setup;
        // rustls with ring; the platform's trust store checks certificates.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let sites = Arc::new(sites);
        let clients = Clients::new(&sites, proxy.get())?;
        Ok(Net {
            sites,
            proxy,
            clients: std::cell::RefCell::new(clients),
            in_flight: Arc::new(AtomicUsize::new(0)),
            tasks: std::cell::RefCell::default(),
            log,
            offline: false,
        })
    }

    /// [`Net::new`] for `:tutor`'s demo: the same checks and cap, but nothing is ever sent; each
    /// request's answer says so.
    pub fn offline(sites: Vec<Site>, setup: Setup) -> Result<Net, String> {
        let mut net = Net::new(sites, setup)?;
        net.offline = true;
        Ok(net)
    }

    pub fn sites(&self) -> &[Site] {
        &self.sites
    }

    /// Checks what a Plugin asked for: the URL against its sites, the method, the headers.
    pub fn check(
        &self,
        method: &str,
        url: &str,
        headers: Vec<(String, String)>,
        body: Option<Vec<u8>>,
        timeout: Option<f64>,
    ) -> Result<Request, String> {
        let parsed = Url::parse(url).map_err(|e| format!("{url:?} isn't a URL: {e}"))?;
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("a URL with a user or password in it isn't sent: put a token in a header".into());
        }
        if !allowed(&self.sites, &parsed) {
            let may: Vec<String> = self.sites.iter().map(Site::to_string).collect();
            return Err(format!(
                "{} isn't a site this Plugin may reach (it may reach {})",
                parsed.origin().ascii_serialization(),
                may.join(", ")
            ));
        }
        let upper = method.to_ascii_uppercase();
        if !METHODS.contains(&upper.as_str()) {
            return Err(format!("{method:?} isn't a method (there's {})", METHODS.join(", ")));
        }
        if headers.len() > MAX_HEADERS {
            return Err(format!("more than {MAX_HEADERS} headers"));
        }
        let mut checked = Vec::with_capacity(headers.len());
        for (name, value) in headers {
            let lower = name.to_ascii_lowercase();
            if FORBIDDEN_HEADERS.contains(&lower.as_str()) || lower.starts_with("proxy-") {
                return Err(format!("the {name} header is roster's to set"));
            }
            if reqwest::header::HeaderName::from_bytes(lower.as_bytes()).is_err()
                || reqwest::header::HeaderValue::from_str(&value).is_err()
            {
                return Err(format!("the {name:?} header isn't one HTTP can carry"));
            }
            checked.push((lower, value));
        }
        if let Some(b) = &body
            && b.len() > MAX_REQUEST_BODY
        {
            return Err(format!("the body is over {MAX_REQUEST_BODY} bytes"));
        }
        let timeout = match timeout {
            None => MAX_TIMEOUT,
            Some(t) if t.is_finite() && t > 0.0 => Duration::from_secs_f64(t).min(MAX_TIMEOUT),
            Some(_) => return Err("the timeout is a number of seconds above 0".into()),
        };
        Ok(Request {
            method: Method::from_bytes(upper.as_bytes()).map_err(|e| e.to_string())?,
            url: parsed,
            headers: checked,
            body,
            timeout,
        })
    }

    /// Starts `request`; `done` gets the answer on a network thread. Refused when the Plugin has
    /// [`MAX_IN_FLIGHT`] requests going already.
    pub fn start(&self, request: Request, done: impl FnOnce(Answer) + Send + 'static) -> Result<(), String> {
        let rt = runtime()?;
        // check() made sure a site allows it; counted by that site, never by its URL.
        let site = site_for(&self.sites, &request.url)
            .cloned()
            .ok_or("not a site this Plugin may reach")?;
        let proxy = self.proxy.get();
        if self.clients.borrow().proxy != proxy {
            *self.clients.borrow_mut() = Clients::new(&self.sites, proxy)?;
        }
        let clients = self.clients.borrow();
        let client = clients.for_site(&site).ok_or("no client for that pinned site")?;
        // Through the proxy, the name is still looked up here first ([`proxied`]).
        let look_up = match (&clients.proxy, request.url.host()) {
            (Some(p), Some(url::Host::Domain(d))) if p.carries(&self.sites, &request.url) => Some(d.to_string()),
            _ => None,
        };
        drop(clients);
        let n = self.in_flight.fetch_add(1, Ordering::SeqCst);
        if n >= MAX_IN_FLIGHT {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return Err(format!(
                "{MAX_IN_FLIGHT} requests are going already: wait for one to answer"
            ));
        }
        let in_flight = Arc::clone(&self.in_flight);
        if self.offline {
            let why = format!(
                "{} wasn't sent: the tutorial's demo reaches no network (:tutor quit, then try it for real)",
                request.url
            );
            // Counted as going until the Plugin has heard the answer, so the cap holds as online.
            drop(rt.spawn_blocking(move || {
                done(Answer::Failed(why));
                in_flight.fetch_sub(1, Ordering::SeqCst);
            }));
            return Ok(());
        }
        self.log.sent(&site);
        let (log, counted) = (Arc::clone(&self.log), site.clone());
        let settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done_once = Arc::clone(&settled);
        let task = rt.spawn(async move {
            let checked = match look_up {
                Some(host) => tokio::task::spawn_blocking(move || proxied_lookup(&host))
                    .await
                    .unwrap_or_else(|e| Err(e.to_string())),
                None => Ok(()),
            };
            let answer = match checked {
                Ok(()) => fetch(&client, request).await,
                Err(why) => Answer::Failed(why),
            };
            in_flight.fetch_sub(1, Ordering::SeqCst);
            // Counted once: here, or by the unload that stopped it.
            if !done_once.swap(true, Ordering::SeqCst) && matches!(answer, Answer::Failed(_)) {
                log.failed(&counted);
            }
            // Delivering waits for the Plugin's thread: not on a network thread.
            let _ = tokio::task::spawn_blocking(move || done(answer)).await;
        });
        let mut tasks = self.tasks.borrow_mut();
        tasks.retain(|t| !t.task.is_finished());
        tasks.push(Going {
            task: task.abort_handle(),
            settled,
            site,
        });
        Ok(())
    }
}

impl Drop for Net {
    /// The Plugin is gone (unloaded, reloaded, disabled): its requests stop with it, and one
    /// that hadn't answered yet counts as one with no answer.
    fn drop(&mut self) {
        for t in self.tasks.borrow().iter() {
            t.task.abort();
            if !t.settled.swap(true, Ordering::SeqCst) {
                self.log.failed(&t.site);
            }
        }
    }
}

/// A client for `sites`: the shared one (`pinned` is `None`), whose redirects never lead to a
/// pinned site, or a pinned site's, which trusts only its pin and is never redirected off it.
fn build(sites: &Arc<Vec<Site>>, proxy: Option<&Proxy>, pinned: Option<&Site>) -> Result<Client, String> {
    let for_redirects = Arc::clone(sites);
    let mine = pinned.cloned();
    let via = proxy.cloned();
    let mut builder = Client::builder()
        .no_proxy()
        .referer(false)
        .retry(reqwest::retry::never())
        .redirect(redirect::Policy::custom(move |attempt| {
            let to = attempt.url().origin().ascii_serialization();
            if attempt.previous().len() > MAX_REDIRECTS {
                attempt.error(format!("more than {MAX_REDIRECTS} redirects"))
            } else if !allowed(&for_redirects, attempt.url()) {
                attempt.error(format!("redirected to {to}, which the Plugin may not reach"))
            } else if client_of(&for_redirects, attempt.url()) != mine.as_ref() {
                attempt.error(format!(
                    "redirected to {to}: a redirect never leads to or from a site with a pinned certificate"
                ))
            } else if let Some(Err(why)) = via
                .as_ref()
                .filter(|p| p.carries(&for_redirects, attempt.url()))
                .and_then(|_| attempt.url().host_str().map(str::to_string))
                // The policy runs on a network thread: let tokio move its other work meanwhile.
                .map(|host| tokio::task::block_in_place(|| proxied_lookup(&host)))
            {
                attempt.error(why)
            } else {
                attempt.follow()
            }
        }))
        .dns_resolver(Checked {
            sites: Arc::clone(sites),
            proxy: proxy.and_then(Proxy::name),
        })
        .connect_timeout(CONNECT_TIMEOUT)
        .pool_max_idle_per_host(2)
        .pool_idle_timeout(Duration::from_secs(30))
        .user_agent(concat!("roster/", env!("CARGO_PKG_VERSION")));
    if let Some(site) = pinned {
        builder = builder.tls_backend_preconfigured(pinned_tls(site)?);
    }
    // Added after no_proxy(): only this one, never the environment's or the system's.
    if let Some(proxy) = proxy {
        let (proxy, sites) = (proxy.clone(), Arc::clone(sites));
        builder = builder.proxy(reqwest::Proxy::custom(move |url| {
            proxy.carries(&sites, url).then(|| proxy.url.clone())
        }));
    }
    builder
        .build()
        .map_err(|e| format!("couldn't start the HTTP client: {}", chain(&e)))
}

/// TLS that trusts one certificate for one site (decision Q116): the end certificate's SHA-256
/// must be the pin, the handshake must be signed with that certificate's key (checked as rustls
/// always does), and the name asked for must be the site's. No chain, no expiry, no OS trust.
fn pinned_tls(site: &Site) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let name = match &site.host {
        SiteHost::Name(n) => rustls::pki_types::ServerName::try_from(n.clone()).map_err(|e| e.to_string())?,
        SiteHost::Ip(ip) => rustls::pki_types::ServerName::IpAddress((*ip).into()),
        SiteHost::Under(_) => return Err("a wildcard has no pin".into()),
    };
    let verifier = Pinned {
        name,
        pin: site.pin.ok_or("no pin")?,
        algorithms: provider.signature_verification_algorithms,
    };
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

/// A certificate the pin refuses: "the certificate isn't the one pinned: WHY" (`describe` drops
/// rustls's "unexpected error: " before a general error).
fn refused(why: String) -> rustls::Error {
    rustls::Error::General(format!("the certificate isn't the one pinned: {why}"))
}

#[derive(Debug)]
struct Pinned {
    name: rustls::pki_types::ServerName<'static>,
    pin: Pin,
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl rustls::client::danger::ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if *server_name != self.name {
            return Err(refused(format!(
                "the pin is for {}, not {}",
                self.name.to_str(),
                server_name.to_str()
            )));
        }
        let got = Pin::of(end_entity.as_ref());
        // Both are public; the comparison needn't be constant-time.
        if got != self.pin {
            return Err(refused(format!(
                "its SHA-256 is {got}, not the {} the manifest pins",
                self.pin
            )));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

async fn fetch(client: &Client, request: Request) -> Answer {
    let timeout = request.timeout;
    let mut builder = client.request(request.method, request.url).timeout(timeout);
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = match builder.send().await {
        Ok(r) => r,
        Err(e) => return Answer::Failed(describe(&e, timeout)),
    };
    let status = response.status().as_u16();
    let url = response.url().to_string();
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in response.headers() {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        match headers.iter_mut().find(|(n, _)| n == name.as_str()) {
            Some((_, v)) => {
                v.push_str(", ");
                v.push_str(&value);
            }
            None => headers.push((name.as_str().to_string(), value)),
        }
    }
    if response.content_length().is_some_and(|n| n > MAX_RESPONSE_BODY as u64) {
        return Answer::Failed(format!("the response is over {MAX_RESPONSE_BODY} bytes"));
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_RESPONSE_BODY {
                    return Answer::Failed(format!("the response is over {MAX_RESPONSE_BODY} bytes"));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Answer::Failed(describe(&e, timeout)),
        }
    }
    Answer::Response {
        status,
        url,
        headers,
        body,
    }
}

/// A failure as one line: what failed, then its first cause (`couldn't connect to
/// http://127.0.0.1:1: tcp connect error: Connection refused (os error 111)`).
fn describe(e: &reqwest::Error, timeout: Duration) -> String {
    if e.is_timeout() {
        return format!("no answer within {} s", timeout.as_secs_f64());
    }
    let origin = e.url().map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    // reqwest's own text repeats the URL; the causes say what happened.
    let mut causes = Vec::new();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        let shown = s.to_string();
        let text = shown.strip_prefix("unexpected error: ").unwrap_or(&shown).to_string();
        if !causes.iter().any(|c: &String| c.contains(&text)) && text != "client error (Connect)" {
            causes.push(text);
        }
        source = s.source();
    }
    let why = if causes.is_empty() {
        e.to_string()
    } else {
        causes.join(": ")
    };
    if e.is_redirect() {
        why
    } else if e.is_connect() {
        format!("couldn't connect to {origin}: {why}")
    } else if e.is_body() || e.is_decode() {
        format!("the answer from {origin} broke off: {why}")
    } else {
        format!("{origin}: {why}")
    }
}

fn chain(e: &dyn std::error::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut source = e.source();
    while let Some(s) = source {
        let text = s.to_string();
        if !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        source = s.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn a_site_is_matched_exactly() {
        let site = Site::parse("api.example.com").unwrap();
        assert!(site.allows(&url("https://api.example.com/v1?x=1")));
        assert!(site.allows(&url("https://API.Example.com:443/")));
        for no in [
            "http://api.example.com/",
            "https://api.example.com:8443/",
            "https://example.com/",
            "https://x.api.example.com/",
            "https://api.example.com.evil.example/",
            "https://evil-api.example.com/",
            "https://api.example.com./",
        ] {
            assert!(!site.allows(&url(no)), "{no} must not be allowed");
        }
    }

    #[test]
    fn a_wildcard_is_the_names_under_a_domain_and_not_the_domain() {
        let site = Site::parse("*.example.com").unwrap();
        assert!(site.allows(&url("https://a.example.com/")));
        assert!(site.allows(&url("https://a.b.example.com/")));
        assert!(!site.allows(&url("https://example.com/")));
        assert!(!site.allows(&url("https://badexample.com/")));
        assert!(!site.allows(&url("https://a.example.com.evil.example/")));
    }

    #[test]
    fn http_and_a_port_are_allowed_only_when_written() {
        let site = Site::parse("http://127.0.0.1:8080").unwrap();
        assert!(site.allows(&url("http://127.0.0.1:8080/x")));
        assert!(!site.allows(&url("https://127.0.0.1:8080/x")));
        assert!(!site.allows(&url("http://127.0.0.1/x")));
        assert!(!site.allows(&url("http://localhost:8080/x")));
        // The URL parser writes other spellings of an address the one way.
        assert!(site.allows(&url("http://2130706433:8080/")));
        assert!(
            Site::parse("[fd00::5]:8443")
                .unwrap()
                .allows(&url("https://[fd00:0::5]:8443/"))
        );
    }

    #[test]
    fn a_name_never_matches_an_address() {
        let site = Site::parse("api.example.com").unwrap();
        assert!(!site.allows(&url("https://45.10.20.30/")));
    }

    #[test]
    fn sites_print_as_they_were_written() {
        for s in [
            "api.example.com",
            "*.example.com",
            "http://10.0.0.5:8080",
            "[fd00::5]",
            "xn--bcher-kva.example",
        ] {
            assert_eq!(Site::parse(s).unwrap().to_string(), s);
        }
    }

    /// DNS rebinding and names that point inside: `localhost` is in every hosts file, so no
    /// network is needed. The connection only ever gets the addresses this returns.
    #[test]
    fn a_name_that_resolves_to_this_computer_is_refused() {
        use std::str::FromStr;
        let rt = runtime().unwrap();
        let err = match rt.block_on(
            Checked {
                sites: Arc::default(),
                proxy: None,
            }
            .resolve(Name::from_str("localhost").unwrap()),
        ) {
            Ok(addrs) => panic!("localhost resolved to {:?}", addrs.collect::<Vec<_>>()),
            Err(e) => e.to_string(),
        };
        assert!(
            err.contains("localhost is at") && err.contains("private network"),
            "{err}"
        );
    }

    #[test]
    fn private_and_special_addresses_are_not_public() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.1",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "fc00::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "2002:7f00:1::",
            "2001:db8::1",
            "fec0::1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip} must not count as public");
        }
        for ip in [
            "45.10.20.30",
            "172.32.0.1",
            "2a05:1234::1",
            "::ffff:45.10.20.30",
            "2002:2d0a:141e::",
        ] {
            assert!(is_public(ip.parse().unwrap()), "{ip} is public");
        }
    }

    const PIN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn a_private_site_is_a_name_on_the_private_network() {
        for s in ["private:nas.lan", "private:http://nas.lan:8080", "private:appliance"] {
            let site = Site::parse(s).unwrap();
            assert!(site.private, "{s}");
            assert_eq!(site.to_string(), s);
        }
        let site = Site::parse("private:nas.lan").unwrap();
        assert!(site.allows(&url("https://nas.lan/status")));
        assert!(!site.allows(&url("http://nas.lan/status")));
        assert!(!site.allows(&url("https://x.nas.lan/")));
        for no in [
            "private:",
            "private:10.0.0.5",
            "private:[fd00::5]",
            "private:*.lan",
            "private:localhost",
            "private:x.localhost",
            "private:private:nas.lan",
            "http://private:nas.lan",
            "private:NAS.lan",
        ] {
            assert!(Site::parse(no).is_err(), "{no} must be refused");
        }
    }

    #[test]
    fn a_pin_names_one_certificate_for_one_https_site() {
        for s in [
            format!("appliance.example.com#sha256:{PIN}"),
            format!("private:appliance.lan:8443#sha256:{PIN}"),
            format!("10.0.0.5:8443#sha256:{PIN}"),
            format!("[fd00::5]#sha256:{PIN}"),
        ] {
            let site = Site::parse(&s).unwrap();
            assert_eq!(site.pin.map(|p| p.to_string()).as_deref(), Some(PIN), "{s}");
            assert_eq!(site.to_string(), s);
        }
        let upper = PIN.to_uppercase();
        let colons: Vec<String> = PIN
            .as_bytes()
            .chunks(2)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect();
        for no in [
            format!("http://10.0.0.5#sha256:{PIN}"),
            format!("*.example.com#sha256:{PIN}"),
            format!("10.0.0.5#sha256:{upper}"),
            format!("10.0.0.5#sha256:{}", colons.join(":")),
            format!("10.0.0.5#sha256:{}", &PIN[2..]),
            format!("10.0.0.5#md5:{}", &PIN[..32]),
            "10.0.0.5#sha256:".to_string(),
            "10.0.0.5#".to_string(),
        ] {
            assert!(Site::parse(&no).is_err(), "{no} must be refused");
        }
    }

    #[test]
    fn a_pinned_site_still_matches_by_scheme_name_and_port() {
        let site = Site::parse(&format!("private:appliance.lan:8443#sha256:{PIN}")).unwrap();
        assert!(site.allows(&url("https://appliance.lan:8443/api")));
        assert!(!site.allows(&url("https://appliance.lan/api")));
    }

    fn sites(list: &[&str]) -> Vec<Site> {
        list.iter().map(|s| Site::parse(s).unwrap()).collect()
    }

    #[test]
    fn a_name_listed_as_private_is_reached_only_through_its_private_site() {
        // A wildcard over it doesn't widen it to another scheme or port.
        let both = sites(&["*.example.lan", "private:http://nas.example.lan:8080"]);
        assert!(allowed(&both, &url("http://nas.example.lan:8080/")));
        assert!(!allowed(&both, &url("https://nas.example.lan/")));
        assert!(allowed(&both, &url("https://web.example.lan/")));
        assert_eq!(Mode::of(&both, "nas.example.lan", None), Mode::Private);
        assert_eq!(Mode::of(&both, "web.example.lan", None), Mode::Public);
    }

    fn addrs(list: &[&str]) -> Vec<SocketAddr> {
        list.iter().map(|a| SocketAddr::new(a.parse().unwrap(), 0)).collect()
    }

    #[test]
    fn a_private_name_reaches_only_private_addresses() {
        for ok in [
            &["10.0.0.5"][..],
            &["192.168.1.20", "fd00::5"],
            &["172.16.0.9"],
            &["100.64.0.7"],
        ] {
            assert!(Mode::Private.admit("nas.lan", addrs(ok)).is_ok(), "{ok:?}");
        }
        for no in [
            &["45.10.20.30"][..],
            &["10.0.0.5", "45.10.20.30"],
            &["127.0.0.1"],
            &["::1"],
            &["169.254.169.254"],
            &["fe80::1"],
            &["0.0.0.0"],
            &["224.0.0.1"],
            &["::ffff:127.0.0.1"],
        ] {
            let e = Mode::Private.admit("nas.lan", addrs(no)).unwrap_err();
            assert!(e.contains("nas.lan is at"), "{e}");
        }
    }

    #[test]
    fn a_public_name_reaches_only_public_addresses() {
        assert!(Mode::Public.admit("api.example.com", addrs(&["45.10.20.30"])).is_ok());
        for no in [&["10.0.0.5"][..], &["45.10.20.30", "192.168.1.1"], &["127.0.0.1"]] {
            assert!(Mode::Public.admit("api.example.com", addrs(no)).is_err(), "{no:?}");
        }
    }

    #[test]
    fn a_proxy_is_an_http_address_with_no_credentials() {
        for ok in [
            "http://10.0.0.5:3128",
            "http://proxy.example.com:8080",
            "http://proxy:3128",
            "http://[fd00::5]:3128",
        ] {
            let p = Proxy::parse(ok).unwrap();
            assert_eq!(p.to_string(), ok);
        }
        for no in [
            "http://someone:secret@10.0.0.5:3128",
            "http://someone@10.0.0.5:3128",
            "https://10.0.0.5:3128",
            "socks5://10.0.0.5:1080",
            "http://10.0.0.5:3128/path",
            "http://10.0.0.5:3128?x=1",
            "10.0.0.5:3128",
            "",
            "http://10.0.0.5",
            "http://10.0.0.5:",
            "http://10.0.0.5:0",
            "http://10.0.0.5:65536",
            "http://[fd00::5]",
            "http://:3128",
        ] {
            assert!(Proxy::parse(no).is_err(), "{no} must be refused");
        }
        // The default port written out, a trailing slash and an upper-case name are all the same
        // proxy, not "write it in lower case".
        assert_eq!(
            Proxy::parse("http://10.0.0.5:80").unwrap().to_string(),
            "http://10.0.0.5:80"
        );
        assert_eq!(
            Proxy::parse("http://Proxy.Example.com:8080/").unwrap().to_string(),
            "http://proxy.example.com:8080"
        );
        assert_eq!(
            Proxy::parse("http://[fd00:0::5]:3128").unwrap().to_string(),
            "http://[fd00::5]:3128"
        );
        let e = Proxy::parse("http://10.0.0.5").unwrap_err();
        assert!(e.contains("port"), "{e}");
        let e = Proxy::parse("http://someone:secret@10.0.0.5:3128").unwrap_err();
        assert!(!e.contains("secret"), "the error repeats the password: {e}");
    }

    #[test]
    fn only_public_names_go_through_the_proxy() {
        let proxy = Proxy::parse("http://10.0.0.5:3128").unwrap();
        let s = sites(&["api.example.com", "*.example.org", "10.0.0.9", "private:nas.lan"]);
        assert!(proxy.carries(&s, &url("https://api.example.com/")));
        assert!(proxy.carries(&s, &url("https://a.example.org/")));
        assert!(!proxy.carries(&s, &url("https://10.0.0.9/")));
        assert!(!proxy.carries(&s, &url("https://nas.lan/")));
    }

    /// Through the proxy, a public name is still looked up here first: any address inside refuses
    /// it, as without a proxy. Only a name this computer can't look up at all goes on to the proxy.
    #[test]
    fn a_public_name_through_the_proxy_is_still_checked_where_it_can_be() {
        assert!(proxied("api.example.com", Ok(addrs(&["45.10.20.30"]))).is_ok());
        for inside in [
            &["10.0.0.5"][..],
            &["45.10.20.30", "127.0.0.1"],
            &["169.254.169.254"],
            &["fd00::5"],
        ] {
            let e = proxied("api.example.com", Ok(addrs(inside))).unwrap_err();
            assert!(e.contains("api.example.com is at"), "{e}");
        }
        assert!(proxied("api.example.com", Err("no such name".into())).is_ok());
        assert!(proxied("api.example.com", Ok(Vec::new())).is_ok());
    }
}
