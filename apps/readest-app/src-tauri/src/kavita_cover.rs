use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::IpAddr, time::Instant};
use tauri::State;
use tokio::sync::{watch, Mutex};

const MAX_COVER_BYTES: usize = 16 * 1024 * 1024;
// Shelf covers are thumbnails. Keeping the long edge at 320 px materially
// reduces Android WebView decode cost while retaining enough detail for the
// largest shelf cards.
const MAX_COVER_EDGE: u32 = 320;
const JPEG_QUALITY: u8 = 82;

pub struct KavitaCoverFetchState {
    requests: Mutex<HashMap<String, watch::Sender<bool>>>,
    strict_client: reqwest::Client,
    insecure_client: reqwest::Client,
}

impl Default for KavitaCoverFetchState {
    fn default() -> Self {
        let client = |allow_invalid_tls| {
            reqwest::Client::builder()
                .danger_accept_invalid_certs(allow_invalid_tls)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Kavita cover HTTP client must initialize")
        };
        Self {
            requests: Mutex::new(HashMap::new()),
            strict_client: client(false),
            insecure_client: client(true),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KavitaCoverFetchRequest {
    request_id: String,
    base_url: String,
    chapter_id: i64,
    auth_key: String,
    allow_invalid_tls: bool,
    etag: Option<String>,
    last_modified: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KavitaCoverFileResponse {
    status: u16,
    content_type: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    retry_after: Option<String>,
    body_base64: Option<String>,
    network_ms: u64,
    optimize_ms: u64,
    body_bytes: usize,
}

fn is_safe_base_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    if url.scheme() == "https" {
        return url.host_str().is_some();
    }
    if url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn network_error_category(error: &reqwest::Error) -> String {
    // Never return reqwest's display text: it can contain the URL and therefore
    // the Auth Key query parameter. Only a fixed, redacted category crosses IPC.
    let details = format!("{error:?}").to_ascii_lowercase();
    if details.contains("certificate") || details.contains("tls") || details.contains("ssl") {
        "tls".to_string()
    } else {
        "network".to_string()
    }
}

fn optimize_raster_cover(
    bytes: &[u8],
    content_type: Option<&str>,
) -> Result<(Vec<u8>, Option<String>), String> {
    let mime = content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif"
    ) {
        return Ok((bytes.to_vec(), content_type.map(ToOwned::to_owned)));
    }
    let mut image = image::load_from_memory(bytes).map_err(|_| "invalid-response".to_string())?;
    if image.width() == 0 || image.height() == 0 {
        return Err("invalid-response".to_string());
    }
    if image.width().max(image.height()) > MAX_COVER_EDGE {
        image = image.resize(
            MAX_COVER_EDGE,
            MAX_COVER_EDGE,
            image::imageops::FilterType::Triangle,
        );
    }
    let rgb = image.to_rgb8();
    let mut output = Vec::with_capacity(bytes.len().min(256 * 1024));
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, JPEG_QUALITY)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|_| "invalid-response".to_string())?;
    Ok((output, Some("image/jpeg".to_string())))
}

#[tauri::command]
pub async fn fetch_kavita_cover(
    state: State<'_, KavitaCoverFetchState>,
    request: KavitaCoverFetchRequest,
) -> Result<KavitaCoverFileResponse, String> {
    if !valid_request_id(&request.request_id)
        || request.auth_key.is_empty()
        || request.chapter_id <= 0
        || !is_safe_base_url(&request.base_url)
    {
        return Err("invalid-request".to_string());
    }

    let endpoint = format!(
        "{}/api/Image/chapter-cover",
        request.base_url.trim_end_matches('/')
    );
    let mut url = reqwest::Url::parse(&endpoint).map_err(|_| "invalid-request".to_string())?;
    url.query_pairs_mut()
        .clear()
        .append_pair("chapterId", &request.chapter_id.to_string())
        .append_pair("apiKey", &request.auth_key);

    let client = if request.allow_invalid_tls {
        state.insecure_client.clone()
    } else {
        state.strict_client.clone()
    };

    let mut builder = client
        .get(url)
        .header(reqwest::header::ACCEPT, "image/*")
        .header("x-api-key", &request.auth_key);
    if let Some(etag) = request.etag.as_deref() {
        builder = builder.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    if let Some(last_modified) = request.last_modified.as_deref() {
        builder = builder.header(reqwest::header::IF_MODIFIED_SINCE, last_modified);
    }

    let (cancel, mut cancelled) = watch::channel(false);
    state
        .requests
        .lock()
        .await
        .insert(request.request_id.clone(), cancel);

    let result = async {
        let network_started = Instant::now();
        let response = tokio::select! {
            result = builder.send() => result.map_err(|error| network_error_category(&error))?,
            _ = cancelled.changed() => return Err("cancelled".to_string()),
        };
        let status = response.status().as_u16();
        let headers = response.headers();
        let mut metadata = KavitaCoverFileResponse {
            status,
            content_type: headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            etag: headers
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            last_modified: headers
                .get(reqwest::header::LAST_MODIFIED)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            retry_after: headers
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            body_base64: None,
            network_ms: 0,
            optimize_ms: 0,
            body_bytes: 0,
        };

        if status != 304 && !(200..300).contains(&status) {
            return Ok(metadata);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_COVER_BYTES as u64)
        {
            return Err("invalid-response".to_string());
        }

        // Hyper aggregates the body internally. Awaiting every small chunk in
        // this command caused severe scheduler overhead on Android emulators.
        let body = tokio::select! {
            result = response.bytes() => result.map_err(|error| network_error_category(&error))?,
            _ = cancelled.changed() => return Err("cancelled".to_string()),
        };
        if body.len() > MAX_COVER_BYTES {
            return Err("invalid-response".to_string());
        }
        metadata.network_ms = network_started.elapsed().as_millis() as u64;
        let optimize_started = Instant::now();
        let (body, content_type) =
            optimize_raster_cover(body.as_ref(), metadata.content_type.as_deref())?;
        metadata.optimize_ms = optimize_started.elapsed().as_millis() as u64;
        metadata.body_bytes = body.len();
        metadata.content_type = content_type;
        metadata.body_base64 = Some(base64::engine::general_purpose::STANDARD.encode(body));
        Ok(metadata)
    }
    .await;

    state.requests.lock().await.remove(&request.request_id);
    result
}

#[tauri::command]
pub async fn cancel_kavita_cover_fetch(
    state: State<'_, KavitaCoverFetchState>,
    request_id: String,
) -> Result<(), String> {
    if let Some(cancel) = state.requests.lock().await.remove(&request_id) {
        let _ = cancel.send(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_policy_allows_private_http_and_public_https_only() {
        assert!(is_safe_base_url("http://127.0.0.1:5000"));
        assert!(is_safe_base_url("http://192.168.1.10:5000/kavita"));
        assert!(is_safe_base_url("http://reader.local:5000"));
        assert!(is_safe_base_url("https://books.example.com"));
        assert!(!is_safe_base_url("http://books.example.com"));
        assert!(!is_safe_base_url("ftp://192.168.1.10/file"));
        assert!(!is_safe_base_url("https://user:secret@books.example.com"));
        assert!(!is_safe_base_url("https://books.example.com/#apiKey=secret"));
    }

    #[test]
    fn response_metadata_never_contains_credentials() {
        let metadata = KavitaCoverFileResponse {
            status: 200,
            content_type: Some("image/png".to_string()),
            etag: None,
            last_modified: None,
            retry_after: None,
            body_base64: Some("AQID".to_string()),
            network_ms: 12,
            optimize_ms: 3,
            body_bytes: 3,
        };
        let encoded = serde_json::to_string(&metadata).unwrap();
        assert!(!encoded.contains("apiKey"));
        assert!(!encoded.contains("auth"));
    }

    #[test]
    fn temporary_file_ids_cannot_escape_the_cache_namespace() {
        assert!(valid_request_id("8d1d2c20-a507-44a7-a753-428f1df9ea7d"));
        assert!(!valid_request_id("../secret"));
        assert!(!valid_request_id("request/child"));
    }

    #[test]
    fn raster_cover_is_decoded_and_reencoded_as_a_small_jpeg() {
        let mut seed = 0x1234_5678_u32;
        let image = image::RgbImage::from_fn(320, 455, |_x, _y| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            image::Rgb([seed as u8, (seed >> 8) as u8, (seed >> 16) as u8])
        });
        let mut source = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut source, image::ImageFormat::Png)
            .unwrap();
        let source = source.into_inner();

        let (optimized, mime) = optimize_raster_cover(&source, Some("image/png")).unwrap();
        let decoded = image::load_from_memory(&optimized).unwrap();
        assert_eq!(mime.as_deref(), Some("image/jpeg"));
        assert_eq!((decoded.width(), decoded.height()), (225, 320));
        assert!(optimized.len() < source.len());
    }
}
