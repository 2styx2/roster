//! The user's proxy for Plugins' requests (`plugin_proxy` in init.lua, decision Q116), as an
//! address: what the Config checks and the Plugin network client connects through
//! ([`crate::plugin::network`] adds how a request goes through it).

use std::fmt;
use url::Url;

/// The user's proxy for Plugins' requests (`plugin_proxy` in init.lua, decision Q116): an
/// `http://HOST:PORT` address and nothing else, never credentials. A Plugin can't set or see it.
/// Only requests to public names go through it; a `private:` site and an address go direct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proxy {
    /// `http://HOST:PORT/`, as the URL parser writes it (it leaves out port 80).
    pub(crate) url: Url,
    /// The port as written, 80 too.
    pub(crate) port: u16,
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
}

/// init.lua's `plugin_proxy` is read straight into a [`Proxy`]: a bad one is the Config's error at
/// `plugin_proxy`, with [`Proxy::parse`]'s words.
impl<'de> serde::Deserialize<'de> for Proxy {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Proxy, D::Error> {
        let text = String::deserialize(d)?;
        Proxy::parse(&text).map_err(serde::de::Error::custom)
    }
}

/// The Config as the app gets it shows the proxy as text (`http://HOST:PORT`).
impl serde::Serialize for Proxy {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

/// The proxy as the user wrote it, for the user's own messages (init.lua's). Never in a message a
/// Plugin hears: a Plugin doesn't see where the user's proxy is.
impl fmt::Display for Proxy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.url.host() {
            Some(host) => write!(f, "http://{host}:{}", self.port),
            None => f.write_str("http://"),
        }
    }
}
