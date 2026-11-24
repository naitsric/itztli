//! The network, for plugins that declared what they reach.

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::{Method, Url, redirect};
use serde::{Deserialize, Serialize};

use crate::error::{CommandError, CommandResult, ErrorCode};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_BODY: usize = 20 * 1024 * 1024;

fn failed(e: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorCode::Network, e.to_string())
}

/// Whether an address is at one of the origins.
fn allowed(url: &Url, origins: &[String]) -> bool {
    let origin = url.origin();
    origin.is_tuple() && origins.iter().filter_map(|o| Url::parse(o).ok()).any(|o| o.origin() == origin)
}

pub async fn fetch(request: Request, origins: &[String]) -> CommandResult<Response> {
    let url = Url::parse(&request.url).map_err(failed)?;
    let refuse = |url: &Url| failed(format!("this plugin did not ask to reach {}", url.origin().ascii_serialization()));
    if !allowed(&url, origins) {
        return Err(refuse(&url));
    }
    let method = request.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let method = Method::from_bytes(method.as_bytes()).map_err(failed)?;

    // A redirect is a new address, with the same rule.
    let origins = origins.to_vec();
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 5 || !allowed(attempt.url(), &origins) { attempt.stop() } else { attempt.follow() }
        }))
        .build()
        .map_err(failed)?;

    let mut builder = client.request(method, url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = builder.send().await.map_err(failed)?;
    let status = response.status().as_u16();
    let headers =
        response.headers().iter().filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_owned()))).collect();
    let body = read_body(&mut response).await?;
    Ok(Response { status, headers, body: String::from_utf8_lossy(&body).into_owned() })
}

/// An image a note shows from the web, once the user allowed those.
pub async fn image(url: &str) -> CommandResult<(String, Vec<u8>)> {
    let url = Url::parse(url).map_err(failed)?;
    if url.scheme() != "https" {
        return Err(failed("only https images are loaded"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(redirect::Policy::custom(|a| {
            if a.previous().len() > 5 || a.url().scheme() != "https" { a.stop() } else { a.follow() }
        }))
        .build()
        .map_err(failed)?;
    let mut response = client.get(url).send().await.and_then(|r| r.error_for_status()).map_err(failed)?;
    let mime = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    if !mime.starts_with("image/") {
        return Err(failed("not an image"));
    }
    let bytes = read_body(&mut response).await?;
    Ok((mime, bytes))
}

async fn read_body(response: &mut reqwest::Response) -> CommandResult<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            return Err(failed(format!("the response is bigger than {} MB", MAX_BODY / 1024 / 1024)));
        }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_match_exactly() {
        let origins = vec!["https://api.x.com".to_owned(), "http://localhost:11434".to_owned()];
        let ok = |u: &str| allowed(&Url::parse(u).unwrap(), &origins);
        assert!(ok("https://api.x.com/v1?q=1") && ok("https://api.x.com:443/") && ok("http://localhost:11434/api"));
        for bad in [
            "http://api.x.com/",
            "https://x.com/",
            "https://api.x.com.evil.io/",
            "https://api.x.com:8443/",
            "http://localhost/",
            "data:text/plain,x",
        ] {
            assert!(!ok(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn undeclared_addresses_are_refused() {
        let request = Request { url: "https://example.com".into(), method: None, headers: BTreeMap::new(), body: None };
        let e = fetch(request, &[]).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Network);
        assert!(e.message.contains("did not ask"));
    }
}
