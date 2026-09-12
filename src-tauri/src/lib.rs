// AiKF · Bangumi 官方 API 集成（https://github.com/bangumi/api）
//
// - `bgm_fetch`：通用 HTTP 命令（GET/POST/PATCH/PUT/DELETE）。Bangumi 强制
//   要求自定义 User-Agent（浏览器 fetch 不允许覆盖 UA），因此所有 Bangumi
//   请求必须经由此命令从 Rust 侧发出。
// - `bgm_oauth_start` / `bgm_oauth_stop`：OAuth 授权码流程的本地回调服务。
//   在 127.0.0.1 上监听，接收 bgm.tv 授权完成后的跳转 code，
//   通过 `bgm-oauth-code` 事件推送给前端后自动退出。

pub mod cache;

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Bangumi 官方 User-Agent 规范：
/// https://github.com/bangumi/api/blob/master/docs-raw/user%20agent.md
/// 格式：`应用名/版本 (项目主页)`
const BGM_USER_AGENT: &str = "Ming-QWQ520/AiKF/0.1.0 (https://github.com/Ming-QWQ520/AiKF)";

#[derive(Debug, Serialize, Deserialize)]
struct BgmFetchArgs {
    method: String,
    url: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    /// 请求体：JSON 字符串或 form 编码串（由调用方构造）
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BgmFetchResult {
    status: u16,
    ok: bool,
    body: String,
    headers: std::collections::HashMap<String, String>,
}

fn bgm_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(BGM_USER_AGENT)
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(4)
        .tcp_nodelay(true)
        .build()
        .expect("failed to build bangumi reqwest client")
}

#[tauri::command]
async fn bgm_fetch(args: BgmFetchArgs) -> Result<BgmFetchResult, String> {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(bgm_client).clone();

    let method = reqwest::Method::from_bytes(args.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid method: {}", e))?;

    let mut req = client.request(method, &args.url);
    for (k, v) in &args.headers {
        req = req.header(k, v);
    }
    if let Some(b) = &args.body {
        // Content-Type 由调用方通过 headers 传入（JSON / form 各不同）
        req = req.body(b.clone());
    }

    let res = req.send().await.map_err(|e| format!("request error: {}", e))?;
    let status = res.status().as_u16();
    let ok = res.status().is_success();

    let mut headers = std::collections::HashMap::new();
    for (k, v) in res.headers() {
        if let Ok(vs) = v.to_str() {
            headers.insert(k.as_str().to_string(), vs.to_string());
        }
    }

    let body = res
        .text()
        .await
        .map_err(|e| format!("body read error: {}", e))?;

    Ok(BgmFetchResult { status, ok, body, headers })
}

// ── OAuth 本地回调服务 ──

/// OAuth 回调监听端口（redirect_uri = http://localhost:{PORT}/callback）。
const OAUTH_PORT: u16 = 27420;

#[derive(Serialize)]
struct OauthStartResult {
    port: u16,
    redirect_uri: String,
}

/// 启动一次性回调服务器：收到 /callback?code=... 后 emit 事件并自动退出。
/// 重复调用会先停掉上一次未完成的监听。
#[tauri::command]
async fn bgm_oauth_start(app: tauri::AppHandle) -> Result<OauthStartResult, String> {
    use tauri::Emitter;

    // 若已有监听在跑，先终止
    bgm_oauth_stop();

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", OAUTH_PORT))
        .await
        .map_err(|e| format!("无法监听端口 {}（可能被占用）: {}", OAUTH_PORT, e))?;

    let handle = tokio::spawn(async move {
        // 一次性 accept：处理完第一个 callback 请求（或明显非法请求）即退出。
        // 设置 10 分钟超时防止长期挂起。
        let _ = tokio::time::timeout(Duration::from_secs(600), async {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                // 请求行形如 "GET /callback?code=xxx&state=yyy HTTP/1.1"
                let line = req.lines().next().unwrap_or("");
                let target = line.split_whitespace().nth(1).unwrap_or("");
                let (path, query) = match target.split_once('?') {
                    Some((p, q)) => (p, q),
                    None => (target, ""),
                };

                if path == "/callback" {
                    let mut code: Option<String> = None;
                    let mut err: Option<String> = None;
                    for kv in query.split('&') {
                        let mut it = kv.splitn(2, '=');
                        let k = it.next().unwrap_or("");
                        let v = it.next().unwrap_or("");
                        match k {
                            "code" => code = Some(v.to_string()),
                            "error_description" | "error" => {
                                if err.is_none() {
                                    err = Some(v.to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                    let body = if code.is_some() {
                        "<html><head><meta charset='utf-8'><title>AiKF</title></head><body style='font-family:sans-serif;text-align:center;padding-top:80px'><h2>✅ 授权成功</h2><p>请返回 AiKF 窗口，登录即将完成…</p></body></html>"
                    } else {
                        "<html><head><meta charset='utf-8'><title>AiKF</title></head><body style='font-family:sans-serif;text-align:center;padding-top:80px'><h2>❌ 授权失败</h2><p>请关闭此页面并回到 AiKF 重试。</p></body></html>"
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.flush().await;
                    if let Some(c) = code {
                        let _ = app.emit("bgm-oauth-code", c);
                    } else {
                        let _ = app.emit("bgm-oauth-error", err.unwrap_or_else(|| "授权被取消".into()));
                    }
                } else {
                    // 非 callback 路径（例如用户手滑访问根路径）——简单应答后继续等待
                    let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<h3>AiKF OAuth 回调服务运行中…</h3>";
                    let _ = stream.write_all(resp.as_bytes()).await;
                }
            }
        })
        .await;
    });

    // 保存句柄供取消
    {
        let mut slot = OAUTH_TASK.lock().await;
        *slot = Some(handle);
    }

    Ok(OauthStartResult {
        port: OAUTH_PORT,
        redirect_uri: format!("http://localhost:{}/callback", OAUTH_PORT),
    })
}

/// 停止回调监听（用户取消登录时调用）。
#[tauri::command]
async fn bgm_oauth_stop() {
    let mut slot = OAUTH_TASK.lock().await;
    if let Some(h) = slot.take() {
        h.abort();
    }
}

static OAUTH_TASK: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>> =
    tokio::sync::Mutex::const_new(None);

use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
            bgm_fetch,
            bgm_oauth_start,
            bgm_oauth_stop,
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
