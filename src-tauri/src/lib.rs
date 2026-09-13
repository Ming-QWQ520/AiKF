// AiKF · Bangumi 官方 API 集成（https://github.com/bangumi/api）
//
// - `bgm_fetch`：通用 HTTP 命令（GET/POST/PATCH/PUT/DELETE）。Bangumi 强制
//   要求自定义 User-Agent（浏览器 fetch 不允许覆盖 UA），因此所有 Bangumi
//   请求必须经由此命令从 Rust 侧发出。
// - `bgm_oauth_start` / `bgm_oauth_stop` / `bgm_oauth_take_pending`：OAuth
//   授权码流程（aikf:// 自定义协议回调，RFC 8252）。授权完成后 bgm.tv 把
//   浏览器重定向到 aikf://auth/callback?code=...，系统直接拉起 AiKF.exe：
//   已运行实例由 single-instance 插件转交 URL；冷启动在 setup 解析参数。
//   code 经 `bgm-oauth-code` 事件推送给前端，另有 pending 槽位轮询兑底。
// - 日志系统：tauri-plugin-log 写入 exe 所在目录\log\yyyy-MM-dd HH-mm.log
//   （Windows 文件名禁止冒号，故用 HH-mm），前端 console 经 attachConsole
//   汇聚到同一文件；级别 Debug，含网络请求、OAuth 全流程、缓存与崩溃信息。

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

    log::debug!("[anich] GET {}", args.url);
    let started = std::time::Instant::now();

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
                        log::warn!("[anich] attempt {}/{} 响应体读取失败: {}", attempt + 1, MAX_RETRIES + 1, e);
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
                    log::warn!("[anich] attempt {}/{} -> HTTP {}（可重试），800ms 后重试", attempt + 1, MAX_RETRIES + 1, status);
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }

                log::info!(
                    "[anich] GET {} -> HTTP {} · {} ms · {} bytes · attempt {}/{}",
                    args.url, status, started.elapsed().as_millis(), body.len(), attempt + 1, MAX_RETRIES + 1
                );
                return Ok(FetchResult { status, ok, body, headers });
            }
            Err(e) => {
                last_err = Some(format!("request error: {}", e));
                log::warn!("[anich] attempt {}/{} 请求失败: {}", attempt + 1, MAX_RETRIES + 1, e);
                if attempt < MAX_RETRIES {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }
                log::error!("[anich] GET {} 彻底失败: {}", args.url, last_err.as_ref().unwrap());
                return Err(last_err.unwrap());
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "max retries exceeded".to_string()))
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

    log::debug!("[bgm] {} {}", args.method, args.url);
    let started = std::time::Instant::now();

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

    if ok {
        log::info!(
            "[bgm] {} {} -> HTTP {} · {} ms · {} bytes",
            args.method, args.url, status, started.elapsed().as_millis(), body.len()
        );
    } else {
        log::warn!(
            "[bgm] {} {} -> HTTP {} · {} ms · body: {}",
            args.method, args.url, status, started.elapsed().as_millis(),
            body.chars().take(300).collect::<String>()
        );
    }

    Ok(BgmFetchResult { status, ok, body, headers })
}

// ── OAuth（aikf:// 自定义协议回调，RFC 8252）──
//
// 授权完成后 bgm.tv 把浏览器重定向到 aikf://auth/callback?code=...&state=...，
// Windows 依据注册表协议定义直接拉起 AiKF.exe 并把 URL 作为命令行参数传入：
// - 应用已运行 → tauri-plugin-single-instance 把参数转交主实例后新进程退出；
// - 应用未运行 → setup 中解析自身命令行参数。
// code 校验 state 后写入 pending 槽位并 emit `bgm-oauth-code` 事件；
// 前端监听事件，另有 `bgm_oauth_take_pending` 轮询兜底（事件早于监听器就绪）。

/// Bangumi 开发者后台登记的回调地址（须与后台「回调地址」完全一致）。
pub const OAUTH_REDIRECT_URI: &str = "aikf://auth/callback";

const BGM_CLIENT_ID: &str = "bgm71176aa5120285808";

/// state / pending 的有效期（与授权页会话时长对齐）。
const OAUTH_TTL: Duration = Duration::from_secs(600);

#[derive(Serialize)]
struct OauthStartResult {
    authorize_url: String,
    redirect_uri: String,
}

// std::sync::Mutex：短临界区、无 await，供同步上下文（single-instance 回调 /
// setup）与 async 命令共用。
static PENDING_CODE: std::sync::Mutex<Option<(String, std::time::Instant)>> =
    std::sync::Mutex::new(None);
static EXPECTED_STATE: std::sync::Mutex<Option<(String, std::time::Instant)>> =
    std::sync::Mutex::new(None);

/// 生成 OAuth state（纳秒时钟 + 进程 ID + 计数器 + ASLR 地址混合哈希）。
fn gen_oauth_state() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .hash(&mut h);
    std::process::id().hash(&mut h);
    COUNTER.fetch_add(1, Ordering::Relaxed).hash(&mut h);
    (&h as *const _ as usize).hash(&mut h);
    format!("{:016x}", h.finish())
}

/// 启动一次 OAuth 登录：生成 state 并返回授权页 URL（不再监听本地端口）。
#[tauri::command]
async fn bgm_oauth_start() -> Result<OauthStartResult, String> {
    *PENDING_CODE.lock().unwrap() = None;
    let state = gen_oauth_state();
    *EXPECTED_STATE.lock().unwrap() = Some((state.clone(), std::time::Instant::now()));

    let mut u = tauri::Url::parse("https://bgm.tv/oauth/authorize")
        .map_err(|e| format!("parse authorize url: {}", e))?;
    u.query_pairs_mut()
        .append_pair("client_id", BGM_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", OAUTH_REDIRECT_URI)
        .append_pair("state", &state);
    let authorize_url = u.to_string();

    log::info!("[bgm-oauth] start · redirect_uri={} · authorize_url={}", OAUTH_REDIRECT_URI, authorize_url);
    Ok(OauthStartResult {
        authorize_url,
        redirect_uri: OAUTH_REDIRECT_URI.to_string(),
    })
}

/// 取走待消费的授权码（10 分钟内有效）。事件丢失时的轮询兑底。
#[tauri::command]
async fn bgm_oauth_take_pending() -> Option<String> {
    let mut slot = PENDING_CODE.lock().unwrap();
    match slot.take() {
        Some((code, at)) if at.elapsed() < OAUTH_TTL => {
            log::info!("[bgm-oauth] pending code 被前端取走（len={}）", code.len());
            Some(code)
        }
        Some((code, _)) => {
            log::warn!("[bgm-oauth] 丢弃过期 pending code（len={}）", code.len());
            None
        }
        None => None,
    }
}

/// 停止登录流程（用户取消 / 超时）：清空预期 state 与 pending code。
#[tauri::command]
async fn bgm_oauth_stop() {
    *EXPECTED_STATE.lock().unwrap() = None;
    *PENDING_CODE.lock().unwrap() = None;
    log::info!("[bgm-oauth] stopped（取消或超时）");
}

/// 解析 aikf:// 回调 URL：校验 state → 存 pending → 通知前端。
fn handle_protocol_url(app: &tauri::AppHandle, raw: &str) {
    use tauri::Emitter;

    log::info!("[bgm-oauth] 收到协议回调: {}", raw);
    let parsed = match tauri::Url::parse(raw) {
        Ok(u) => u,
        Err(e) => {
            log::error!("[bgm-oauth] URL 解析失败: {} ({})", raw, e);
            let _ = app.emit("bgm-oauth-error", format!("invalid callback url: {}", e));
            return;
        }
    };

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut err: Option<String> = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" | "error_description" => {
                if err.is_none() {
                    err = Some(v.into_owned());
                }
            }
            _ => {}
        }
    }

    match code {
        Some(c) => {
            // state 校验：登记中的 state 必须与回调一致且未过期；
            // 无登记（冷启动残留码被复用等场景）时放行。
            let valid = match EXPECTED_STATE.try_lock() {
                Ok(mut guard) => match guard.take() {
                    Some((expected, at)) => {
                        let ok = state.as_deref() == Some(expected.as_str()) && at.elapsed() < OAUTH_TTL;
                        if !ok {
                            log::warn!("[bgm-oauth] state 不匹配或过期（expected 已消费）");
                        }
                        ok
                    }
                    None => true,
                },
                Err(_) => true,
            };
            if !valid {
                let _ = app.emit("bgm-oauth-error", "state mismatch");
                return;
            }
            log::info!("[bgm-oauth] code 校验通过（len={}），存 pending 并推送前端", c.len());
            *PENDING_CODE.lock().unwrap() = Some((c.clone(), std::time::Instant::now()));
            let _ = app.emit("bgm-oauth-code", c);
        }
        None => {
            let msg = err.unwrap_or_else(|| "授权被取消".into());
            log::warn!("[bgm-oauth] 授权失败/取消: {}", msg);
            let _ = app.emit("bgm-oauth-error", msg);
        }
    }
}

// ── aikf:// URL 协议注册 ──

/// 运行时注册 aikf:// 协议（写入 HKCU\Software\Classes，无需管理员；
/// 便携版每次启动自愈，安装版另有 NSIS 写入 HKLM 兜底）。
#[cfg(windows)]
fn register_aikf_protocol() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[protocol] 无法定位 exe，跳过 aikf:// 注册: {}", e);
            return;
        }
    };
    let cmd = format!("\"{}\" \"%1\"", exe.display());
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.create_subkey("Software\\Classes\\aikf") {
        Ok((key, _)) => {
            let _ = key.set_value("", &"URL:AiKF Protocol");
            let _ = key.set_value("URL Protocol", &"");
            if let Ok((icon, _)) = key.create_subkey("DefaultIcon") {
                let _ = icon.set_value("", &format!("{},0", exe.display()));
            }
            if let Ok((open, _)) = key.create_subkey("shell\\open\\command") {
                let _ = open.set_value("", &cmd);
            }
            log::info!("[protocol] aikf:// 已注册（HKCU）· command={}", cmd);
        }
        Err(e) => log::warn!("[protocol] aikf:// 注册失败: {}", e),
    }
}

// ── 日志目录 ──

/// 日志目录：exe 所在目录\log（只读/不可写时回退 %TEMP%\AiKF\log）。
fn resolve_log_dir() -> std::path::PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if let Some(dir) = exe_dir {
        let log_dir = dir.join("log");
        if std::fs::create_dir_all(&log_dir).is_ok() {
            // 探针：确认可写（只读目录 create_dir_all 也可能成功）
            let probe = log_dir.join(".aikf-log-probe");
            if std::fs::write(&probe, b"ok").is_ok() {
                let _ = std::fs::remove_file(&probe);
                return log_dir;
            }
        }
    }
    let fallback = std::env::temp_dir().join("AiKF").join("log");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// 打开日志文件夹（设置页「打开日志文件夹」按钮），返回实际路径。
#[tauri::command]
fn log_open_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = resolve_log_dir();
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
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

    // 日志文件：exe目录\log\yyyy-MM-dd HH-mm.log（Windows 文件名禁冒号 → HH-mm）
    let log_dir = resolve_log_dir();
    let log_file_name = chrono::Local::now().format("%Y-%m-%d %H-%M").to_string();
    let log_dir_for_setup = log_dir.clone();
    let log_file_for_setup = log_file_name.clone();

    tauri::Builder::default()
        // single-instance 必须最先注册：aikf:// 回调拉起的新进程在此把 URL
        // 转交给主实例后退出（并顺带把主窗口带回前台）。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            log::info!("[single-instance] 第二实例启动，args={:?}，转交后退出", args);
            for a in &args {
                if a.starts_with("aikf://") {
                    handle_protocol_url(app, a);
                }
            }
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                        path: log_dir,
                        file_name: Some(log_file_name),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .level(log::LevelFilter::Debug)
                .max_file_size(20 * 1024 * 1024) // 20MB，超出滚动新文件
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .format(|out, message, record| {
                    out.finish(format_args!(
                        "[{}] [{}] [{}] {}",
                        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                        record.level(),
                        record.target(),
                        message
                    ))
                })
                .build(),
        )
        .setup(move |app| {
            let handle = app.handle().clone();

            // panic 兜底写入日志（release 为 abort，但 hook 在 abort 前仍会执行）
            std::panic::set_hook(Box::new(|info| {
                log::error!("[panic] {}", info);
            }));

            // 每次启动自愈式注册 aikf:// 协议（便携版无安装器写入）
            #[cfg(windows)]
            register_aikf_protocol();

            log::info!("================ AiKF 启动 ================");
            log::info!("[boot] version={}", env!("CARGO_PKG_VERSION"));
            log::info!("[boot] exe={:?}", std::env::current_exe());
            log::info!("[boot] log 文件 = {}\\{}.log", log_dir_for_setup.display(), log_file_for_setup);
            log::info!("[boot] args={:?}", std::env::args().collect::<Vec<_>>());

            // 冷启动协议回调：应用未运行时经 aikf:// 拉起，URL 在自身命令行里
            let cold_urls: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| a.starts_with("aikf://"))
                .collect();
            if !cold_urls.is_empty() {
                log::info!("[boot] 检测到冷启动协议回调 {} 条", cold_urls.len());
                for url in cold_urls {
                    handle_protocol_url(&handle, &url);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            anich_fetch,
            bgm_fetch,
            bgm_oauth_start,
            bgm_oauth_stop,
            bgm_oauth_take_pending,
            log_open_dir,
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
