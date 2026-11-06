//! Anchors for help headings, as GitHub and the app's help make them, shared by the Config's and
//! the Plugin API's generated docs.

/// GitHub's anchor for a heading (and the help's: app/src/help/doc.ts `slug`).
pub fn slug(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '_' || *c == '-')
        .collect::<String>()
        .trim()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect()
}
