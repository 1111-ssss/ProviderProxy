//! Static assets of the single-page GUI, embedded at compile time.
//!
//! The interface is one document (`index.html`) plus stylesheets and scripts
//! linked by it. Both the desktop WebView and a normal browser reach them over
//! the same local HTTP server, so the files are served from here rather than
//! read from disk. Adding a file means adding a line to `ASSETS` and a matching
//! `<link>`/`<script>` tag in `index.html`.

use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};

/// `(path, body, content-type)` for every served asset.
const ASSETS: &[(&str, &str, &str)] = &[
    ("/", include_str!("../../frontend/index.html"), "text/html; charset=utf-8"),
    ("/css/tokens.css", include_str!("../../frontend/css/tokens.css"), "text/css; charset=utf-8"),
    ("/css/layout.css", include_str!("../../frontend/css/layout.css"), "text/css; charset=utf-8"),
    ("/css/components.css", include_str!("../../frontend/css/components.css"), "text/css; charset=utf-8"),
    ("/css/pages.css", include_str!("../../frontend/css/pages.css"), "text/css; charset=utf-8"),
    ("/js/core.js", include_str!("../../frontend/js/core.js"), "text/javascript; charset=utf-8"),
    ("/js/providers.js", include_str!("../../frontend/js/providers.js"), "text/javascript; charset=utf-8"),
    ("/js/dialogs-provider.js", include_str!("../../frontend/js/dialogs-provider.js"), "text/javascript; charset=utf-8"),
    ("/js/dialogs-chain.js", include_str!("../../frontend/js/dialogs-chain.js"), "text/javascript; charset=utf-8"),
    ("/js/models.js", include_str!("../../frontend/js/models.js"), "text/javascript; charset=utf-8"),
    ("/js/connections.js", include_str!("../../frontend/js/connections.js"), "text/javascript; charset=utf-8"),
    ("/js/shared.js", include_str!("../../frontend/js/shared.js"), "text/javascript; charset=utf-8"),
    ("/js/images.js", include_str!("../../frontend/js/images.js"), "text/javascript; charset=utf-8"),
    ("/js/tabs.js", include_str!("../../frontend/js/tabs.js"), "text/javascript; charset=utf-8"),
    ("/js/logs.js", include_str!("../../frontend/js/logs.js"), "text/javascript; charset=utf-8"),
    ("/js/usage.js", include_str!("../../frontend/js/usage.js"), "text/javascript; charset=utf-8"),
];

/// Serve one embedded asset. Unknown paths fall through to a 404.
pub(crate) fn serve(path: &str) -> Response {
    let path = if path == "/index.html" { "/" } else { path };
    match ASSETS.iter().find(|(name, _, _)| *name == path) {
        Some((_, body, content_type)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, *content_type),
                // The GUI is rebuilt with the binary, so a stale cached copy
                // would show an old interface after an update.
                (header::CACHE_CONTROL, "no-store, max-age=0"),
            ],
            *body,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
