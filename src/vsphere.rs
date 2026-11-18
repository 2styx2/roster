//! `login: vsphere`: ESXi and vCenter log in through their SOAP API at
//! `/sdk` and answer with a `vmware_soap_session` cookie. roster logs in,
//! makes the one call with the cookie, and logs out again, since ESXi
//! allows few sessions at once. A call under `/sdk` gets the SOAPAction
//! header, and a bare `<urn:Call>...</urn:Call>` body its envelope.

use crate::Fail;
use crate::vault::Secret;
use crate::web::{Call, failed, http, option};
use zeroize::Zeroizing;

const HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><soapenv:Envelope \
    xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:urn=\"urn:vim25\">\
    <soapenv:Body>";
const TAIL: &str = "</soapenv:Body></soapenv:Envelope>";
const RETRIEVE: &str = "<urn:RetrieveServiceContent><urn:_this type=\"ServiceInstance\">\
    ServiceInstance</urn:_this></urn:RetrieveServiceContent>";
pub const CONTENT_TYPE: &str = "Content-Type: text/xml; charset=utf-8";

/// A logged-in session: the cookie, the SOAPAction to send, and the
/// SessionManager to log out with.
pub struct Session {
    cookie: Zeroizing<String>,
    pub action: String,
    manager: String,
}

impl Session {
    pub fn config(&self) -> Zeroizing<String> {
        let mut config = Zeroizing::new(String::new());
        option(&mut config, "header", &["Cookie: ", &self.cookie]);
        config
    }
}

/// `body` in a SOAP envelope, unless it has one.
pub fn envelope(body: &str) -> Zeroizing<String> {
    let mut out = Zeroizing::new(String::new());
    if body.contains(":Envelope") {
        out.push_str(body);
    } else {
        out.extend([HEAD, body.trim(), TAIL]);
    }
    out
}

/// `text` with `&`, `<`, `>` and quotes escaped, appended to `out`.
fn escape(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
}

/// The text between `start` and the next `<` in `text`.
fn between<'a>(text: &'a str, start: &str) -> Option<&'a str> {
    let rest = &text[text.find(start)? + start.len()..];
    rest.split('<').next().filter(|t| !t.trim().is_empty())
}

/// POST one SOAP call to `/sdk`; `-D -` when `headers` is set.
fn soap(
    call: &Call,
    action: &str,
    body: &str,
    cookie: &str,
    headers: bool,
    secret: &Secret,
) -> Result<(u16, Zeroizing<Vec<u8>>), Fail> {
    let mut config = Zeroizing::new(cookie.to_string());
    option(&mut config, "data-raw", &[&envelope(body)]);
    let action = format!("SOAPAction: {action}");
    let mut extra = Vec::new();
    if headers {
        extra.extend(["-D", "-"]);
    }
    extra.extend(["-H", CONTENT_TYPE, "-H", &action]);
    let url = format!("{}/sdk", call.base);
    call.curl(&extra, "POST", &url, &config, Some(secret))
}

/// Log in. Its errors hold neither the password nor the cookie.
pub fn login(call: &Call, user: &str, secret: &Secret) -> Result<Session, Fail> {
    let what = format!("{}: vsphere login to /sdk", call.what);
    // The newest API version the server speaks; no login needed.
    let url = format!("{}/sdk/vimServiceVersions.xml", call.base);
    let (_, versions) = call.curl(&[], "GET", &url, "", Some(secret))?;
    let versions = String::from_utf8_lossy(&versions);
    let version = versions
        .split("<name>urn:vim25</name>")
        .nth(1)
        .and_then(|rest| between(rest, "<version>"));
    let action = version.map_or("urn:vim25".into(), |v| format!("urn:vim25/{}", v.trim()));
    let (_, content) = soap(call, &action, RETRIEVE, "", false, secret)?;
    let content = String::from_utf8_lossy(&content);
    let manager = between(&content, "<sessionManager type=\"SessionManager\">");
    let manager = manager.ok_or_else(|| {
        failed(format!(
            "{what}: no vSphere API there (is it ESXi or vCenter?)"
        ))
    })?;
    let mut this = String::from("<urn:_this type=\"SessionManager\">");
    escape(&mut this, manager);
    this.push_str("</urn:_this>");
    let mut body = Zeroizing::new(format!("<urn:Login>{this}<urn:userName>"));
    escape(&mut body, user);
    body.push_str("</urn:userName><urn:password>");
    escape(&mut body, secret.expose());
    body.push_str("</urn:password></urn:Login>");
    let (status, reply) = soap(call, &action, &body, "", true, secret)?;
    let (cookie, _) = crate::unifi::headers(&reply, "vmware_soap_session=");
    match cookie {
        Some(cookie) if status == 200 => Ok(Session {
            cookie: Zeroizing::new(cookie.to_string()),
            action,
            manager: this,
        }),
        _ => {
            let text = String::from_utf8_lossy(&reply);
            let why = match between(&text, "<faultstring>") {
                Some(fault) => format!("login refused: {}", fault.trim()),
                None if status == 200 => "no vmware_soap_session cookie in the reply".into(),
                None => http(status),
            };
            Err(failed(format!("{what}: {why}")))
        }
    }
}

/// End the session; a failure only leaves it to time out.
pub fn logout(call: &Call, session: &Session, secret: &Secret) {
    let body = format!("<urn:Logout>{}</urn:Logout>", session.manager);
    let _ = soap(
        call,
        &session.action,
        &body,
        &session.config(),
        false,
        secret,
    );
}
