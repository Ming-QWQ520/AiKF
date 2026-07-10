// AiKF · Anich — Tauri backend.
// Registers plugins + provides a custom fetch command that does HTTP requests
// from Rust (bypasses all JS plugin issues + sends no Origin header → Anich API returns 200).

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
struct FetchArgs {
    url: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FetchResult {
    status: u16,
    ok: bool,
    body: Vec<u8>,
    headers: std::collections::HashMap<String, String>,
}

// Shared HTTP client with connection pooling (keeps connections alive for reuse).
// Built once on first use — avoids per-request TLS handshake overhead.
fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("anich Windows 1.0.0")
        .timeout(Duration::from_secs(45))       // generous total timeout (API is slow)
        .connect_timeout(Duration::from_secs(15)) // connection phase timeout
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(4)
        .tcp_nodelay(true)
        .build()
        .expect("failed to build reqwest client")
}

#[tauri::command]
async fn anich_fetch(args: FetchArgs) -> Result<FetchResult, String> {
    // Use a thread-local lazy client (built once, reused across calls)
    let client = {
        use std::sync::OnceLock;
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT.get_or_init(build_client).clone()
    };

    // Retry on transient errors (522, 502, 503, 504, network timeouts).
    // The Anich API is occasionally slow/flaky, so retry up to 2 times.
    const MAX_RETRIES: u32 = 2;
    let retry_statuses = [502u16, 503, 504, 522, 524];

    let mut last_err: Option<String> = None;

    for attempt in 0..=MAX_RETRIES {
        let mut req = client.get(&args.url);
        for (k, v) in &args.headers {
            req = req.header(k, v);
        }

        match req.send().await {
            Ok(res) => {
                let status = res.status().as_u16();
                let ok = res.status().is_success();

                let mut headers = std::collections::HashMap::new();
                for (k, v) in res.headers() {
                    if let Ok(vs) = v.to_str() {
                        headers.insert(k.as_str().to_string(), vs.to_string());
                    }
                }

                let body = match res.bytes().await {
                    Ok(b) => b.to_vec(),
                    Err(e) => {
                        last_err = Some(format!("body read error: {}", e));
                        // retry on body read failure
                        if attempt < MAX_RETRIES {
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            continue;
                        }
                        return Err(last_err.unwrap());
                    }
                };

                // If the status is a retryable transient error, retry
                if !ok && retry_statuses.contains(&status) && attempt < MAX_RETRIES {
                    last_err = Some(format!("HTTP {} (retryable)", status));
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }

                return Ok(FetchResult { status, ok, body, headers });
            }
            Err(e) => {
                last_err = Some(format!("request error: {}", e));
                if attempt < MAX_RETRIES {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }
                return Err(last_err.unwrap());
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "max retries exceeded".to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![anich_fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
