// AiKF · Anich — Tauri backend.
// Registers plugins + provides a custom fetch command that does HTTP requests
// from Rust (bypasses all JS plugin issues + sends no Origin header → Anich API returns 200).
//
// v0.1.0: 新增本地缓存引擎（cache.rs）——JSON 索引 + 多线程 HLS 下载。

pub mod cache;

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
    // 需求：任务管理器中 AiKF 与 WebView2 进程尽量归并、减少独立 WebView 进程。
    // WebView2 官方只提供「禁用独立 UI 子进程」的开关（msWebOOUI 等），
    // 其余浏览器子进程（GPU/渲染/网络）由 Chromium 多进程架构决定，无法合并。
    // 这里同时写入环境变量兜底（additionalBrowserArgs 配置见 tauri.conf.json）。
    #[cfg(target_os = "windows")]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        );
    }

    // 启动即清理上次运行残留的僵尸「downloading」缓存条目，
    // 否则前端选集按钮会因残留状态被永久禁用（表现为无法重新缓存）
    cache::reset_stale_downloads();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            anich_fetch,
            cache::cache_root_path,
            cache::cache_load_index,
            cache::cache_rescan_index,
            cache::cache_open_dir,
            cache::cache_episode_play,
            cache::cache_download_start,
            cache::cache_download_cancel,
            cache::cache_delete,
            cache::cache_danmaku_save,
            cache::cache_danmaku_load,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
