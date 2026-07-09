// AiKF · Anich — Tauri backend.
// Registers plugins + provides a custom fetch command that does HTTP requests
// from Rust (bypasses all JS plugin issues + sends no Origin header → Anich API returns 200).

use serde::{Deserialize, Serialize};

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

#[tauri::command]
async fn anich_fetch(args: FetchArgs) -> Result<FetchResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("anich Windows 1.0.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&args.url);
    for (k, v) in &args.headers {
        req = req.header(k, v);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let ok = res.status().is_success();

    let mut headers = std::collections::HashMap::new();
    for (k, v) in res.headers() {
        if let Ok(vs) = v.to_str() {
            headers.insert(k.as_str().to_string(), vs.to_string());
        }
    }

    let body = res.bytes().await.map_err(|e| e.to_string())?.to_vec();

    Ok(FetchResult { status, ok, body, headers })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![anich_fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
