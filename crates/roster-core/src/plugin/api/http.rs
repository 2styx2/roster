//! `roster.http`: requests to the sites a Plugin was granted (decision Q97). Its functions as the API declares them.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.http.request",
        params: &[
            p("request", "HttpRequest", "What to send: at least its `url`."),
            p(
                "done",
                "fun(response: HttpResponse?, err: string?)",
                "Runs once with the answer: `response` for any status the site gave (a 404 too), or `nil` and why there was none (refused, unreachable, timed out, too big). Its return value is ignored; an error in it counts like an action's.",
            ),
        ],
        summary: "Sends an HTTP request to a site the Plugin was granted",
        doc: "Returns at once; `done` runs later. Each request is checked before anything is sent: its site must be one of the Plugin's `network:<site>` grants (https, unless the site was listed with `http://`; the port the site names, or the scheme's own). The same check stops a redirect to anywhere else.",
        returns: ("", ""),
        errors: &[
            (
                "roster.http.request: https://elsewhere.example isn't a site this Plugin may reach (it may reach SITES)",
                "the URL's scheme, host or port isn't granted",
            ),
            ("roster.http.request: \"URL\" isn't a URL: …", "`url` doesn't parse"),
            (
                "roster.http.request: a URL with a user or password in it isn't sent",
                "the URL has `user:password@`",
            ),
            (
                "roster.http.request: the NAME header is roster's to set",
                "a header that steers the connection: `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Expect`, `Proxy-…`",
            ),
            (
                "roster.http.request: \"METHOD\" isn't a method (there's GET, HEAD, POST, PUT, PATCH, DELETE)",
                "another method",
            ),
            ("roster.http.request: the body is over 262144 bytes", "a longer body"),
            (
                "roster.http.request: 4 requests are going already: wait for one to answer",
                "4 haven't answered yet",
            ),
            (
                "roster.http.request: \"KEY\" isn't a key of a request (there's url, method, headers, body, timeout)",
                "another key in `request`",
            ),
        ],
        refused: &[],
        needs: Needs::AnyNetwork,
        since: 2,
        example: "roster.http.request({\n  url = \"https://hooks.example.com/alerts\",\n  method = \"POST\",\n  headers = { [\"Content-Type\"] = \"application/json\", Authorization = \"Bearer \" .. roster.plugin.config.token },\n  body = '{\"text\": \"esx-02 is down\"}',\n}, function(res, err)\n  if not res then return roster.notify(\"webhook: \" .. err, \"warn\") end\n  if res.status >= 300 then roster.notify(\"webhook said \" .. res.status, \"warn\") end\nend)",
    },
    Function {
        path: "roster.http.get",
        params: &[
            p("url", "string", "The URL, on a site the Plugin was granted."),
            p(
                "done",
                "fun(response: HttpResponse?, err: string?)",
                "As [`roster.http.request`](#rosterhttprequestrequest-done)'s.",
            ),
        ],
        summary: "Fetches a URL from a site the Plugin was granted",
        doc: "`roster.http.request({ url = url }, done)`.",
        returns: ("", ""),
        errors: &[(
            "roster.http.get: …",
            "as [`roster.http.request`](#rosterhttprequestrequest-done)'s",
        )],
        refused: &[],
        needs: Needs::AnyNetwork,
        since: 2,
        example: "roster.http.get(\"https://status.example.com/api/v2/status.json\", function(res, err)\n  roster.status.set(\"upstream\", { text = res and res.status == 200 and \"upstream ok\" or \"upstream ?\" })\nend)",
    },
];
