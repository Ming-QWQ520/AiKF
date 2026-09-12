// AiKF · 本地缓存引擎（v0.1.0 底层重构版）
//
// 职责：
//   1. JSON 索引持久化（data/anime/cache-index.json）——检索不再遍历目录
//   2. 下载引擎：全部线路类型（m3u8 / MP4）统一按「同时缓存 N 集」
//      并发下载（N = 并发集数，1–12，默认 3 —— 需求原话「最高可同时缓存
//      三集」；此前 m3u8 逐集串行，用户反馈「每次只能集中下载一集的 ts
//      文件或 MP4」）；m3u8 每集内部分片再开 1–32 线程（默认 6），落盘到
//      exe所在目录\data\anime\[番剧名称]\[集数-名称]\seg_xxxx.ts + index.m3u8 + episode.json
//   3. 取消 / 删除 / 打开对应文件夹（修复打开成文档目录的问题）
//   4. 进度通过 `cache-progress` 事件推送给前端
//
// 索引结构（CacheIndex）：
//   { version, updatedAt, bangumi: [ { id, title, cover, totalEpisodes,
//       episodes: [ { sort, title, dir, status, segmentsDone, segmentsTotal,
//                     bytes, durationSec, resolution, lineName, error,
//                     cachedAt, updatedAt } ] } ] }

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;

// ─── 数据模型 ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EpisodeCache {
    pub sort: i64,
    #[serde(default)]
    pub title: String,
    /// 相对番剧目录的子目录名（[集数-名称]）
    #[serde(default)]
    pub dir: String,
    /// downloading | done | failed
    #[serde(default)]
    pub status: String,
    /// 源类型："hls"（m3u8 分片）| "mp4"（视频直链单文件）
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub segments_done: u64,
    #[serde(default)]
    pub segments_total: u64,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub duration_sec: f64,
    #[serde(default)]
    pub resolution: String,
    #[serde(default)]
    pub line_name: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub cached_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BangumiCache {
    pub id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub total_episodes: i64,
    #[serde(default)]
    pub episodes: Vec<EpisodeCache>,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheIndex {
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub bangumi: Vec<BangumiCache>,
    #[serde(default)]
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── 路径工具 ────────────────────────────────────────────────────────────

/// 缓存根目录：exe 所在目录\data\anime
pub fn cache_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("获取 exe 路径失败: {e}"))?;
    let dir = exe.parent().ok_or("exe 路径异常")?;
    Ok(dir.join("data").join("anime"))
}

fn index_path() -> Result<PathBuf, String> {
    Ok(cache_root()?.join("cache-index.json"))
}

/// 清理目录名中的非法字符（Windows 保留字符）
fn sanitize(name: &str) -> String {
    let bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\0'];
    let cleaned: String = name
        .chars()
        .map(|c| if bad.contains(&c) || (c as u32) < 32 { ' ' } else { c })
        .collect();
    let t = cleaned.trim();
    if t.is_empty() {
        "未知".to_string()
    } else {
        t.chars().take(64).collect()
    }
}

fn ep_dir_name(sort: i64, title: &str) -> String {
    format!("{:02}-{}", sort, sanitize(title))
}

fn bangumi_dir(root: &Path, title: &str) -> PathBuf {
    root.join(sanitize(title))
}

// ─── 索引读写 ────────────────────────────────────────────────────────────

/// 磁盘扫描重建索引（仅在索引文件缺失/损坏时兜底，不再作为常规检索路径）
fn scan_disk() -> CacheIndex {
    let mut idx = CacheIndex { version: 1, updated_at: now_ms(), bangumi: Vec::new() };
    let root = match cache_root() { Ok(r) => r, Err(_) => return idx };
    let entries = match std::fs::read_dir(&root) { Ok(e) => e, Err(_) => return idx };
    for b in entries.flatten() {
        let bpath = b.path();
        if !bpath.is_dir() { continue; }
        let title = b.file_name().to_string_lossy().to_string();
        let mut bc = BangumiCache { title, updated_at: now_ms(), ..Default::default() };
        if let Ok(eps) = std::fs::read_dir(&bpath) {
            for e in eps.flatten() {
                let epath = e.path();
                if !epath.is_dir() { continue; }
                // 优先读 episode.json 元数据
                let meta = epath.join("episode.json");
                if let Ok(txt) = std::fs::read_to_string(&meta) {
                    if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                        let sort = v.get("sort").and_then(|x| x.as_i64()).unwrap_or(0);
                        bc.episodes.push(EpisodeCache {
                            sort,
                            title: v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            dir: e.file_name().to_string_lossy().to_string(),
                            status: "done".into(),
                            kind: v.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            segments_done: v.get("segments").and_then(|x| x.as_u64()).unwrap_or(0),
                            segments_total: v.get("segments").and_then(|x| x.as_u64()).unwrap_or(0),
                            bytes: v.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0),
                            duration_sec: v.get("durationSec").and_then(|x| x.as_f64()).unwrap_or(0.0),
                            resolution: v.get("resolution").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            line_name: v.get("lineName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            error: String::new(),
                            cached_at: v.get("cachedAt").and_then(|x| x.as_i64()).unwrap_or(0),
                            updated_at: now_ms(),
                        });
                        if bc.id == 0 {
                            bc.id = v.get("bangumiId").and_then(|x| x.as_i64()).unwrap_or(0);
                        }
                        continue;
                    }
                }
                // 没有 episode.json：存在 index.m3u8 或直链文件（episode.mp4/webm/…）也算已完成
                let direct_path = find_direct_file(&epath);
                if epath.join("index.m3u8").exists() || direct_path.is_some() {
                    let name = e.file_name().to_string_lossy().to_string();
                    let sort = name.split('-').next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
                    let kind = if direct_path.is_some() { "mp4".to_string() } else { "hls".to_string() };
                    bc.episodes.push(EpisodeCache {
                        sort,
                        title: name.splitn(2, '-').nth(1).unwrap_or("").to_string(),
                        dir: name,
                        status: "done".into(),
                        kind,
                        bytes: direct_path
                            .as_ref()
                            .and_then(|p| std::fs::metadata(p).ok())
                            .map(|m| m.len())
                            .unwrap_or(0),
                        ..Default::default()
                    });
                }
            }
        }
        if !bc.episodes.is_empty() {
            // 目录名稳定哈希兜底（无 episode.json 元数据时保证 id 稳定且非零）
            if bc.id == 0 {
                let mut h: i64 = 0x2545F4914F6CDD1D;
                for b in bc.title.bytes() {
                    h = h.wrapping_mul(31).wrapping_add(b as i64);
                }
                bc.id = h & 0x7FFF_FFFF_FFFF_FFFF;
            }
            bc.episodes.sort_by_key(|e| e.sort);
            idx.bangumi.push(bc);
        }
    }
    idx
}

/// 读取索引（临界区内部版，【不写回】）。
///
/// ⚠️ 死锁修复：本函数仅供已持有 index_io_lock 的临界区（with_index_mut）
/// 内部调用。此前 with_index_mut → load_index → save_index 会在持锁状态下
/// 再次申请同一把不可重入的 std Mutex——索引文件缺失（首次运行）或损坏时
/// 触发扫盘重建走 save_index，主线程在创建窗口之前即死锁：
/// 进程常驻、无窗口、无任何报错。
/// 重建结果由 with_index_mut 末尾的 save_index_locked 统一写回。
fn load_index_nosave() -> CacheIndex {
    let path = match index_path() { Ok(p) => p, Err(_) => return CacheIndex { version: 1, ..Default::default() } };
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(idx) = serde_json::from_str::<CacheIndex>(&txt) {
            return idx;
        }
    }
    // 索引缺失/损坏 → 扫盘重建（不写回，由调用方临界区落盘）
    scan_disk()
}

/// 读取索引（独立调用版，自动持锁写回）。
/// 供未持锁的调用方使用（cache_load_index / cache_episode_play /
/// cache_danmaku_load）；缺失/损坏时扫盘重建并落盘（自动迁移旧缓存数据）。
fn load_index() -> CacheIndex {
    let path = match index_path() { Ok(p) => p, Err(_) => return CacheIndex { version: 1, ..Default::default() } };
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(idx) = serde_json::from_str::<CacheIndex>(&txt) {
            return idx;
        }
    }
    let idx = scan_disk();
    let _ = save_index(&idx);
    idx
}

/// 索引文件写入锁：MP4 多集并发下载后，多个下载任务会同时 load→modify→save
/// 索引。tmp 文件名固定，两个并发 save 同时写同一 tmp 会产生竞争/损坏。
/// 用全局锁串行化写入（load 侧只读无需锁；单次 save 内的 load-modify-save
/// 竞争窗口 ≤1s，由下一秒的周期性进度写入自愈）。
fn index_io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 写入索引文件（调用方必须已持有 index_io_lock）
fn save_index_locked(idx: &CacheIndex) -> Result<(), String> {
    let root = cache_root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let mut out = idx.clone();
    out.updated_at = now_ms();
    let txt = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
    let tmp = root.join("cache-index.json.tmp");
    let dst = root.join("cache-index.json");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(txt.as_bytes()).map_err(|e| e.to_string())?;
        f.flush().ok();
    }
    std::fs::rename(&tmp, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

/// 写入索引（自动持锁）
fn save_index(idx: &CacheIndex) -> Result<(), String> {
    let _guard = index_io_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    save_index_locked(idx)
}

/// 串行化执行「读取索引 → 修改 → 写回」临界区。
/// MP4 多集并发下载后，多个任务同时 load→modify→save 会互相覆盖丢更新
/// （完成态丢失 → 集数永久卡在 downloading），必须整体持锁。
///
/// ⚠️ 锁纪律：临界区内只允许调用 load_index_nosave / save_index_locked
/// 等无锁变体，绝不可再走 save_index / load_index（会重复加锁死锁，
/// std Mutex 不可重入）。
fn with_index_mut<T>(f: impl FnOnce(&mut CacheIndex) -> T) -> T {
    let _guard = index_io_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let mut idx = load_index_nosave();
    let out = f(&mut idx);
    let _ = save_index_locked(&idx);
    out
}

/// 在索引中定位/插入番剧条目，返回可变引用
///
/// 生命周期说明：返回引用仅借用 `idx`；`title`/`cover` 在函数内即刻
/// 拷贝入索引，与返回值无借用关系，故使用匿名生命周期即可（E0106 修复：
/// 多输入引用时输出生命周期无法自动推导，需显式标注 `'a`）。
fn ensure_bangumi<'a>(idx: &'a mut CacheIndex, id: i64, title: &str, cover: &str, total: i64) -> &'a mut BangumiCache {
    if let Some(pos) = idx.bangumi.iter().position(|b| b.id == id) {
        let b = &mut idx.bangumi[pos];
        if !title.is_empty() { b.title = title.to_string(); }
        if !cover.is_empty() { b.cover = cover.to_string(); }
        if total > 0 { b.total_episodes = total; }
        b.updated_at = now_ms();
        return &mut idx.bangumi[pos];
    }
    idx.bangumi.push(BangumiCache {
        id,
        title: title.to_string(),
        cover: cover.to_string(),
        total_episodes: total,
        episodes: Vec::new(),
        updated_at: now_ms(),
    });
    idx.bangumi.last_mut().unwrap()
}

// ─── 下载任务注册表（取消标志） ─────────────────────────────────────────

fn jobs() -> &'static Mutex<HashMap<String, Vec<Arc<AtomicBool>>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Vec<Arc<AtomicBool>>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn job_key(bangumi_id: i64, sort: i64) -> String {
    format!("{bangumi_id}:{sort}")
}

fn register_cancel(key: &str, flag: Arc<AtomicBool>) {
    jobs().lock().unwrap().entry(key.to_string()).or_default().push(flag);
}

fn take_cancels(key: &str) -> Vec<Arc<AtomicBool>> {
    jobs().lock().unwrap().remove(key).unwrap_or_default()
}

fn is_cancelled(key: &str) -> bool {
    jobs()
        .lock()
        .unwrap()
        .get(key)
        .map(|v| v.iter().any(|f| f.load(Ordering::Relaxed)))
        .unwrap_or(false)
}

/// 番剧级批量取消标志（一次下载批次共享，取消整部番剧时生效）
fn batches() -> &'static Mutex<HashMap<i64, Arc<AtomicBool>>> {
    static BATCHES: OnceLock<Mutex<HashMap<i64, Arc<AtomicBool>>>> = OnceLock::new();
    BATCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

// ─── 进度事件 ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct ProgressEvent {
    #[serde(rename = "bangumiId")]
    bangumi_id: i64,
    sort: i64,
    title: String,
    /// downloading | done | failed | cancelled
    status: String,
    #[serde(rename = "segmentsDone")]
    segments_done: u64,
    #[serde(rename = "segmentsTotal")]
    segments_total: u64,
    bytes: u64,
    /// 估算总体积（字节）：平均分片大小 × 总分片数，随进度收敛趋准；
    /// 0 表示尚无样本无法估算
    #[serde(rename = "bytesTotal")]
    bytes_total: u64,
    /// 字节/秒
    speed: f64,
    #[serde(rename = "errorMsg")]
    error_msg: String,
}

// ─── HTTP 工具 ───────────────────────────────────────────────────────────

fn http_client() -> reqwest::Client {
    // 必须使用完整标准浏览器 UA：带自定义尾缀（如 AiKF/0.1.0）的非标准 UA
    // 会被部分 CDN/WAF（Cloudflare 等）识别为爬虫流量并返回 403，
    // 导致「播放正常但无法缓存」。播放器走 webview 自带标准头，故能播。
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(15))
        .pool_max_idle_per_host(12)
        .tcp_nodelay(true)
        .build()
        .expect("failed to build download client")
}

/// 从 URL 提取 origin 作为 Referer（部分番剧 CDN 校验 Referer，
/// 播放器带浏览器 Referer 可播、下载器不带则 403）
fn referer_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url).ok().map(|u| {
        let host = u.host_str().unwrap_or("");
        let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
        format!("{}://{host}{port}/", u.scheme())
    })
}

/// 下载请求统一携带浏览器特征头（Referer/Accept/Accept-Language）
fn apply_headers(rb: reqwest::RequestBuilder, url: &str) -> reqwest::RequestBuilder {
    let rb = rb
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    match referer_of(url) {
        Some(r) => rb.header("Referer", r),
        None => rb,
    }
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let res = apply_headers(client.get(url), url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    res.text().await.map_err(|e| format!("读取失败: {e}"))
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let res = apply_headers(client.get(url), url)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let body = res.bytes().await.map_err(|e| format!("读取失败: {e}"))?;
    Ok(body.to_vec())
}

// ─── m3u8 解析 ───────────────────────────────────────────────────────────

struct MediaPlaylist {
    /// (duration 秒, 原始 uri)
    segments: Vec<(f64, String)>,
    resolution: String,
    /// 媒体播放列表中除 URI 外需要原样保留的头部标签行
    header_tags: Vec<String>,
}

/// 解析 m3u8：若是 master playlist 则自动选择最高码率的 variant 并递归拉取
async fn resolve_media_playlist(client: &reqwest::Client, url: &str) -> Result<MediaPlaylist, String> {
    resolve_media_playlist_inner(client, url, 0).await
}

/// 内层实现：`depth` 防御异常服务器构造的 master playlist 循环引用
/// （如 A→B→A），避免运行期无限递归拉取
async fn resolve_media_playlist_inner(
    client: &reqwest::Client,
    url: &str,
    depth: u32,
) -> Result<MediaPlaylist, String> {
    if depth >= 4 {
        return Err("m3u8 嵌套层级过深，已中止解析（疑似循环引用）".to_string());
    }
    let text = fetch_text(client, url).await?;
    // 非 HLS 内容（如 MP4 直链二进制）无法作为 m3u8 解析，给出明确错误
    // 而不是笼统的「未找到分片」（前端选源已优先 HLS，此为兑底防御）
    if !text.contains("#EXTM3U") && !text.contains("#EXTINF") && !text.contains("#EXT-X-STREAM-INF") {
        return Err("该集播放源不是 HLS(m3u8) 直链，暂不支持缓存".to_string());
    }
    if text.contains("#EXT-X-STREAM-INF") {
        // master playlist：选最高 BANDWIDTH 的 variant（与旧 cache.rs 语义一致：
        // bw >= best 取等时后者胜出，None 时无条件接受）
        // best: (bandwidth, uri, resolution)
        let mut best: Option<(u64, String, String)> = None;
        // pending: 最近一条 #EXT-X-STREAM-INF 的 (bandwidth, resolution)，等待其下一行 URI
        let mut pending: Option<(u64, String)> = None;
        for line in text.lines() {
            let line = line.trim();
            if let Some(attr) = line.strip_prefix("#EXT-X-STREAM-INF:") {
                let mut bw = 0u64;
                let mut res = String::new();
                for part in attr.split(',') {
                    let part = part.trim();
                    if let Some(v) = part.strip_prefix("BANDWIDTH=") {
                        bw = v.trim().parse().unwrap_or(0);
                    } else if let Some(v) = part.strip_prefix("RESOLUTION=") {
                        res = v.trim().to_string();
                    }
                }
                pending = Some((bw, res));
            } else if !line.is_empty() && !line.starts_with('#') {
                let (bw, res) = pending.take().unwrap_or((0, String::new()));
                let uri = reqwest::Url::parse(url)
                    .and_then(|u| u.join(line))
                    .map(|u| u.to_string())
                    .unwrap_or_else(|_| line.to_string());
                let replace = match &best {
                    None => true,
                    Some((b, _, _)) => bw >= *b,
                };
                if replace {
                    best = Some((bw, uri, res));
                }
            }
        }
        let (_, variant, best_res) = best.ok_or("master playlist 中未找到可用清晰度")?;
        // E0733 修复：async fn 递归会导致 future 大小无法确定，
        // 需用 Box::pin 引入堆上间接层（master 嵌套层数极浅，开销可忽略）
        let mut playlist = Box::pin(resolve_media_playlist_inner(client, &variant, depth + 1)).await?;
        if playlist.resolution.is_empty() {
            playlist.resolution = best_res;
        }
        Ok(playlist)
    } else {
        // 媒体播放列表
        if text.contains("#EXT-X-KEY:METHOD=AES") || text.contains("#EXT-X-KEY:METHOD=SAMPLE-AES") {
            return Err("该线路视频已加密，暂不支持缓存".to_string());
        }
        let mut segments = Vec::new();
        let mut header_tags = Vec::new();
        let mut pending_dur = 0f64;
        let mut seen_first_inf = false;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            if let Some(d) = line.strip_prefix("#EXTINF:") {
                pending_dur = d.split(',').next().and_then(|x| x.trim().parse().ok()).unwrap_or(0f64);
                seen_first_inf = true;
            } else if line.starts_with('#') {
                if !seen_first_inf {
                    header_tags.push(line.to_string());
                }
            } else {
                let uri = reqwest::Url::parse(url)
                    .and_then(|u| u.join(line))
                    .map(|u| u.to_string())
                    .unwrap_or_else(|_| line.to_string());
                segments.push((pending_dur, uri));
                pending_dur = 0f64;
            }
        }
        if segments.is_empty() {
            return Err("播放列表中未找到分片".to_string());
        }
        Ok(MediaPlaylist { segments, resolution: String::new(), header_tags })
    }
}

fn resolution_label(res: &str) -> String {
    // "1920x1080" → "1080P"
    if let Some(h) = res.split('x').nth(1) {
        if let Ok(h) = h.parse::<u32>() {
            return match h {
                2160..=u32::MAX => "4K".into(),
                1440..=2159 => "2K".into(),
                1080..=1439 => "1080P".into(),
                720..=1079 => "720P".into(),
                480..=719 => "480P".into(),
                _ => format!("{h}P"),
            };
        }
    }
    String::new()
}

// ─── 下载核心 ────────────────────────────────────────────────────────────

/// 判断 URL 是否指向视频直链（mp4/webm/mov/m4v/mkv/ts）。
/// 需求：缓存页线路下拉需与播放页一致地显示直链线路（adkwai 等实测为 MP4 直链），
/// 直链支持下载（单线程流式写盘）。
fn is_video_url(url: &str) -> bool {
    let bare = url.split(['?', '#']).next().unwrap_or(url);
    let lower = bare.to_ascii_lowercase();
    [".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ts"].iter().any(|ext| lower.ends_with(ext))
}

/// 直链的保存扩展名（episode.<ext>），视频默认 mp4
fn direct_ext(url: &str) -> String {
    let bare = url.split(['?', '#']).next().unwrap_or(url);
    let lower = bare.to_ascii_lowercase();
    for ext in [".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ts"] {
        if lower.ends_with(ext) {
            return ext.trim_start_matches('.').to_string();
        }
    }
    "mp4".to_string()
}

/// 在集数目录中查找直链文件 episode.<视频扩展名>（排除 .part/episode.json）
fn find_direct_file(dir: &std::path::Path) -> Option<PathBuf> {
    const EXTS: [&str; 6] = [".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ts"];
    let rd = std::fs::read_dir(dir).ok()?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if name.starts_with("episode.")
            && name != "episode.json"
            && !name.ends_with(".part")
            && EXTS.iter().any(|ext| lower.ends_with(ext))
        {
            let p = entry.path();
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartEpisode {
    pub sort: i64,
    pub title: String,
    pub url: String,
    #[serde(rename = "lineName", default)]
    pub line_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartArgs {
    #[serde(rename = "bangumiId")]
    pub bangumi_id: i64,
    pub title: String,
    #[serde(default)]
    pub cover: String,
    #[serde(rename = "totalEpisodes", default)]
    pub total_episodes: i64,
    /// m3u8 分片下载线程数（每集内部）：1–32，默认 6
    #[serde(default)]
    pub threads: Option<u32>,
    /// 并发下载集数（同时缓存几集，m3u8/MP4 全部生效）：1–12，默认 3
    #[serde(rename = "mp4Threads", default)]
    pub mp4_threads: Option<u32>,
    pub episodes: Vec<StartEpisode>,
}

struct EpisodeCtx {
    app: tauri::AppHandle,
    client: reqwest::Client,
    bangumi_id: i64,
    title: String,
    sort: i64,
    line_name: String,
    ep_dir: PathBuf,
    key: String,
    cancel: Arc<AtomicBool>,
    /// 本番剧下载批次的取消标志
    batch_cancel: Arc<AtomicBool>,
    // 共享进度（跨 worker 线程）
    done: Arc<AtomicUsize>,
    bytes_done: Arc<AtomicUsize>,
}

impl EpisodeCtx {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
            || self.batch_cancel.load(Ordering::Relaxed)
            || is_cancelled(&self.key)
    }
}

/// 下载 m3u8 单集：解析播放列表 → 线程池下载分片 → 写 index.m3u8 + episode.json
async fn download_episode_hls(
    app: tauri::AppHandle,
    args: StartArgs,
    ep: StartEpisode,
    threads: u32,
    batch_cancel: Arc<AtomicBool>,
) {
    let key = job_key(args.bangumi_id, ep.sort);
    let cancel = Arc::new(AtomicBool::new(false));
    register_cancel(&key, cancel.clone());
    log::info!("[cache] 开始 HLS 分片下载 {} S{} · threads={}", args.title, ep.sort, threads);

    let root = match cache_root() {
        Ok(r) => r,
        Err(e) => { emit_fail(&app, &args, &ep, &e); cleanup_job(&key); return; }
    };
    let bdir = bangumi_dir(&root, &args.title);
    let dirname = ep_dir_name(ep.sort, &ep.title);
    let ep_dir = bdir.join(&dirname);
    if let Err(e) = std::fs::create_dir_all(&ep_dir) {
        emit_fail(&app, &args, &ep, &format!("创建目录失败: {e}"));
        cleanup_job(&key);
        return;
    }

    let ctx = Arc::new(EpisodeCtx {
        app: app.clone(),
        client: http_client(),
        bangumi_id: args.bangumi_id,
        title: args.title.clone(),
        sort: ep.sort,
        line_name: ep.line_name.clone(),
        ep_dir: ep_dir.clone(),
        key: key.clone(),
        cancel: cancel.clone(),
        batch_cancel,
        done: Arc::new(AtomicUsize::new(0)),
        bytes_done: Arc::new(AtomicUsize::new(0)),
    });

    // 1) 解析播放列表
    let playlist = match resolve_media_playlist(&ctx.client, &ep.url).await {
        Ok(p) => p,
        Err(e) => { mark_failed(&ctx, &e).await; cleanup_job(&key); return; }
    };
    if ctx.cancelled() { on_cancelled(&ctx).await; cleanup_job(&key); return; }

    let total = playlist.segments.len();
    let duration: f64 = playlist.segments.iter().map(|(d, _)| d).sum();
    let resolution = if playlist.resolution.is_empty() {
        String::new()
    } else {
        resolution_label(&playlist.resolution)
    };

    // 2) 更新索引状态 → downloading（with_index_mut：并发批次下持锁读改写）
    with_index_mut(|idx| {
        let b = ensure_bangumi(idx, args.bangumi_id, &args.title, &args.cover, args.total_episodes);
        if let Some(slot) = b.episodes.iter_mut().find(|e| e.sort == ep.sort) {
            slot.status = "downloading".into();
            slot.kind = "hls".into();
            slot.segments_total = total as u64;
            slot.segments_done = 0;
            slot.bytes = 0;
            slot.error.clear();
            slot.dir = dirname.clone();
            slot.title = ep.title.clone();
            slot.line_name = ep.line_name.clone();
            slot.updated_at = now_ms();
        } else {
            b.episodes.push(EpisodeCache {
                sort: ep.sort,
                title: ep.title.clone(),
                dir: dirname.clone(),
                status: "downloading".into(),
                kind: "hls".into(),
                segments_total: total as u64,
                line_name: ep.line_name.clone(),
                updated_at: now_ms(),
                ..Default::default()
            });
        }
    });

    // 3) 线程池下载分片（先写 .part，完成后改名，保证断点可识别）
    let cursor = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let fail_msg = Arc::new(Mutex::new(String::new()));
    let mut workers = Vec::new();
    for _ in 0..threads.clamp(1, 32) {
        let ctx = ctx.clone();
        let cursor = cursor.clone();
        let failed = failed.clone();
        let fail_msg = fail_msg.clone();
        let segs = playlist.segments.clone();
        workers.push(tokio::spawn(async move {
            loop {
                if failed.load(Ordering::Relaxed) || ctx.cancelled() { return; }
                let i = cursor.fetch_add(1, Ordering::SeqCst);
                if i >= segs.len() { return; }
                let (dur, uri) = &segs[i];
                let fname = format!("seg_{:05}.ts", i + 1);
                let dst = ctx.ep_dir.join(&fname);
                let part = ctx.ep_dir.join(format!("{fname}.part"));
                let mut ok = false;
                let mut last_err = String::new();
                for attempt in 0..3u32 {
                    if failed.load(Ordering::Relaxed) || ctx.cancelled() { return; }
                    match fetch_bytes(&ctx.client, uri).await {
                        Ok(bytes) => {
                            match std::fs::File::create(&part).and_then(|mut f| f.write_all(&bytes)) {
                                Ok(()) => {
                                    if std::fs::rename(&part, &dst).is_ok() {
                                        ctx.done.fetch_add(1, Ordering::SeqCst);
                                        ctx.bytes_done.fetch_add(bytes.len(), Ordering::SeqCst);
                                        ok = true;
                                    } else {
                                        last_err = "写入分片失败".into();
                                    }
                                }
                                Err(e) => last_err = format!("写入失败: {e}"),
                            }
                            break;
                        }
                        Err(e) => {
                            last_err = e;
                            let backoff = 600u64 * (attempt as u64 + 1);
                            tokio::time::sleep(Duration::from_millis(backoff)).await;
                        }
                    }
                }
                if !ok {
                    failed.store(true, Ordering::SeqCst);
                    *fail_msg.lock().unwrap() = format!("第{}个分片下载失败: {}", i + 1, last_err);
                    return;
                }
                let _ = dur;
            }
        }));
    }

    // 4) 进度上报循环（每 ~1s 同步索引 + 推送事件）
    let speed_state: Arc<Mutex<(i64, u64)>> = Arc::new(Mutex::new((now_ms(), 0)));
    loop {
        let all_done = workers.iter().all(|w| w.is_finished());
        let done = ctx.done.load(Ordering::SeqCst) as u64;
        let bytes = ctx.bytes_done.load(Ordering::SeqCst) as u64;
        let (lt, lb) = *speed_state.lock().unwrap();
        let dt = (now_ms() - lt).max(1) as f64 / 1000.0;
        let speed = ((bytes as i64 - lb as i64).max(0)) as f64 / dt;
        *speed_state.lock().unwrap() = (now_ms(), bytes);

        with_index_mut(|idx| {
            if let Some(b) = idx.bangumi.iter_mut().find(|b| b.id == args.bangumi_id) {
                if let Some(slot) = b.episodes.iter_mut().find(|e| e.sort == ep.sort) {
                    slot.segments_done = done;
                    slot.segments_total = total as u64;
                    slot.bytes = bytes;
                    slot.updated_at = now_ms();
                }
            }
        });

        let _ = app.emit(
            "cache-progress",
            ProgressEvent {
                bangumi_id: args.bangumi_id,
                sort: ep.sort,
                title: args.title.clone(),
                status: "downloading".into(),
                segments_done: done,
                segments_total: total as u64,
                bytes,
                bytes_total: if done > 0 && total > 0 {
                    ((bytes as f64 / done as f64) * total as f64) as u64
                } else {
                    0
                },
                speed,
                error_msg: String::new(),
            },
        );

        if all_done { break; }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    for w in workers.drain(..) {
        let _ = w.await;
    }

    // 5) 收尾
    if ctx.cancelled() {
        let _ = std::fs::remove_dir_all(&ep_dir);
        remove_episode_from_index(args.bangumi_id, ep.sort);
        let _ = app.emit("cache-progress", ProgressEvent {
            bangumi_id: args.bangumi_id, sort: ep.sort, title: args.title.clone(),
            status: "cancelled".into(), segments_done: 0, segments_total: total as u64,
            bytes: 0, bytes_total: 0, speed: 0.0, error_msg: String::new(),
        });
        cleanup_job(&key);
        return;
    }
    if failed.load(Ordering::SeqCst) {
        let msg = fail_msg.lock().unwrap().clone();
        mark_failed(&ctx, &msg).await;
        cleanup_job(&key);
        return;
    }

    // 6) 写 index.m3u8（重写分片名）+ episode.json
    let mut m3u8 = String::from("#EXTM3U\n");
    for (i, (dur, _uri)) in playlist.segments.iter().enumerate() {
        if i == 0 {
            for tag in &playlist.header_tags {
                m3u8.push_str(tag);
                m3u8.push('\n');
            }
        }
        m3u8.push_str(&format!("#EXTINF:{:.3},\n", dur));
        m3u8.push_str(&format!("seg_{:05}.ts\n", i + 1));
    }
    m3u8.push_str("#EXT-X-ENDLIST\n");
    let m3u8_path = ep_dir.join("index.m3u8");
    if let Err(e) = std::fs::write(&m3u8_path, m3u8) {
        mark_failed(&ctx, &format!("写入 index.m3u8 失败: {e}")).await;
        cleanup_job(&key);
        return;
    }
    let bytes = ctx.bytes_done.load(Ordering::SeqCst) as u64;
    let meta = serde_json::json!({
        "bangumiId": args.bangumi_id,
        "sort": ep.sort,
        "title": ep.title,
        "segments": total,
        "bytes": bytes,
        "durationSec": duration,
        "resolution": resolution,
        "lineName": ep.line_name,
        "cachedAt": now_ms(),
    });
    let _ = std::fs::write(ep_dir.join("episode.json"), serde_json::to_string_pretty(&meta).unwrap_or_default());

    // 7) 索引 → done（持锁读改写，防并发完成态互相覆盖）
    with_index_mut(|idx| {
        if let Some(b) = idx.bangumi.iter_mut().find(|b| b.id == args.bangumi_id) {
            if let Some(slot) = b.episodes.iter_mut().find(|e| e.sort == ep.sort) {
                slot.status = "done".into();
                slot.segments_done = total as u64;
                slot.segments_total = total as u64;
                slot.bytes = bytes;
                slot.duration_sec = duration;
                slot.resolution = resolution;
                slot.error.clear();
                slot.cached_at = now_ms();
                slot.updated_at = now_ms();
            }
        }
    });
    log::info!("[cache] HLS 下载完成 {} S{} · {} 分片 · {} bytes", args.title, ep.sort, total, bytes);
    let _ = app.emit("cache-progress", ProgressEvent {
        bangumi_id: args.bangumi_id, sort: ep.sort, title: args.title.clone(),
        status: "done".into(), segments_done: total as u64, segments_total: total as u64,
        bytes, bytes_total: bytes, speed: 0.0, error_msg: String::new(),
    });
    cleanup_job(&key);
}

/// 下载直链单文件（mp4/webm/mov/m4v/mkv/ts）：固定单线程（需求：直链单线程），
/// 流式写盘（episode.<ext>.part → episode.<ext>），进度按字节上报（segments_total=1）。
async fn download_episode_direct(
    app: tauri::AppHandle,
    args: StartArgs,
    ep: StartEpisode,
    batch_cancel: Arc<AtomicBool>,
) {
    let key = job_key(args.bangumi_id, ep.sort);
    let cancel = Arc::new(AtomicBool::new(false));
    register_cancel(&key, cancel.clone());
    log::info!("[cache] 开始直链下载 {} S{}", args.title, ep.sort);

    let root = match cache_root() {
        Ok(r) => r,
        Err(e) => { emit_fail(&app, &args, &ep, &e); cleanup_job(&key); return; }
    };
    let bdir = bangumi_dir(&root, &args.title);
    let dirname = ep_dir_name(ep.sort, &ep.title);
    let ep_dir = bdir.join(&dirname);
    if let Err(e) = std::fs::create_dir_all(&ep_dir) {
        emit_fail(&app, &args, &ep, &format!("创建目录失败: {e}"));
        cleanup_job(&key);
        return;
    }

    let ctx = Arc::new(EpisodeCtx {
        app: app.clone(),
        client: http_client(),
        bangumi_id: args.bangumi_id,
        title: args.title.clone(),
        sort: ep.sort,
        line_name: ep.line_name.clone(),
        ep_dir: ep_dir.clone(),
        key: key.clone(),
        cancel: cancel.clone(),
        batch_cancel,
        done: Arc::new(AtomicUsize::new(0)),
        bytes_done: Arc::new(AtomicUsize::new(0)),
    });

    // 1) 索引状态 → downloading（kind = mp4，segments_total = 1；持锁读改写）
    let kind = "mp4";
    with_index_mut(|idx| {
        let b = ensure_bangumi(idx, args.bangumi_id, &args.title, &args.cover, args.total_episodes);
        if let Some(slot) = b.episodes.iter_mut().find(|e| e.sort == ep.sort) {
            slot.status = "downloading".into();
            slot.kind = kind.into();
            slot.segments_total = 1;
            slot.segments_done = 0;
            slot.bytes = 0;
            slot.error.clear();
            slot.dir = dirname.clone();
            slot.title = ep.title.clone();
            slot.line_name = ep.line_name.clone();
            slot.updated_at = now_ms();
        } else {
            b.episodes.push(EpisodeCache {
                sort: ep.sort,
                title: ep.title.clone(),
                dir: dirname.clone(),
                status: "downloading".into(),
                kind: kind.into(),
                segments_total: 1,
                line_name: ep.line_name.clone(),
                updated_at: now_ms(),
                ..Default::default()
            });
        }
    });

    // 2) 发起请求（浏览器特征头；单请求超时放宽到 30 分钟防大文件被客户端总超时打断）
    let url = ep.url.clone();
    let res = apply_headers(ctx.client.get(&url), &url)
        .timeout(Duration::from_secs(1800))
        .send()
        .await;
    if ctx.cancelled() { on_cancelled(&ctx).await; cleanup_job(&key); return; }
    let mut res = match res {
        Ok(r) => r,
        Err(e) => { mark_failed(&ctx, &format!("请求失败: {e}")).await; cleanup_job(&key); return; }
    };
    if !res.status().is_success() {
        mark_failed(&ctx, &format!("HTTP {}", res.status())).await;
        cleanup_job(&key);
        return;
    }
    let bytes_total = res.content_length().unwrap_or(0);

    // 3) 流式写盘 + 每秒进度上报（按 URL 扩展名保存 episode.<ext>，兼容 mp4/webm 等）
    let ext = direct_ext(&url);
    let fname = format!("episode.{ext}");
    let part = ep_dir.join(format!("{fname}.part"));
    let dst = ep_dir.join(&fname);
    let mut file = match std::fs::File::create(&part) {
        Ok(f) => f,
        Err(e) => { mark_failed(&ctx, &format!("创建文件失败: {e}")).await; cleanup_job(&key); return; }
    };
    let mut speed_state = (now_ms(), 0u64);
    let mut last_emit = 0i64;
    let mut fail_msg = String::new();
    loop {
        if ctx.cancelled() { on_cancelled(&ctx).await; cleanup_job(&key); return; }
        let chunk = match res.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => { fail_msg = format!("下载中断: {e}"); break; }
        };
        if let Err(e) = file.write_all(&chunk) {
            fail_msg = format!("写入失败: {e}");
            break;
        }
        ctx.bytes_done.fetch_add(chunk.len(), Ordering::SeqCst);
        let now = now_ms();
        if now - last_emit >= 1000 {
            last_emit = now;
            let bytes = ctx.bytes_done.load(Ordering::SeqCst) as u64;
            let dt = (now - speed_state.0).max(1) as f64 / 1000.0;
            let speed = (bytes.saturating_sub(speed_state.1)) as f64 / dt;
            speed_state = (now, bytes);
            with_index_mut(|idx| {
                if let Some(b) = idx.bangumi.iter_mut().find(|b| b.id == args.bangumi_id) {
                    if let Some(slot) = b.episodes.iter_mut().find(|e| e.sort == ep.sort) {
                        slot.bytes = bytes;
                        slot.updated_at = now;
                    }
                }
            });
            let _ = app.emit("cache-progress", ProgressEvent {
                bangumi_id: args.bangumi_id, sort: ep.sort, title: args.title.clone(),
                status: "downloading".into(),
                segments_done: 0, segments_total: 1,
                bytes,
                bytes_total: if bytes_total > 0 { bytes_total } else { bytes },
                speed,
                error_msg: String::new(),
            });
        }
    }
    if !fail_msg.is_empty() {
        let _ = std::fs::remove_file(&part);
        mark_failed(&ctx, &fail_msg).await;
        cleanup_job(&key);
        return;
    }
    if let Err(e) = file.flush() {
        mark_failed(&ctx, &format!("写入失败: {e}")).await;
        cleanup_job(&key);
        return;
    }
    drop(file);
    if let Err(e) = std::fs::rename(&part, &dst) {
        mark_failed(&ctx, &format!("写入 {fname} 失败: {e}")).await;
        cleanup_job(&key);
        return;
    }

    // 4) 收尾：episode.json + 索引 done + 事件（file 字段记录实际文件名，供本地播放回退）
    let bytes = ctx.bytes_done.load(Ordering::SeqCst) as u64;
    let meta = serde_json::json!({
        "bangumiId": args.bangumi_id,
        "sort": ep.sort,
        "title": ep.title,
        "kind": kind,
        "file": fname,
        "segments": 1,
        "bytes": bytes,
        "durationSec": 0,
        "resolution": "",
        "lineName": ep.line_name,
        "cachedAt": now_ms(),
    });
    let _ = std::fs::write(ep_dir.join("episode.json"), serde_json::to_string_pretty(&meta).unwrap_or_default());
    with_index_mut(|idx| {
        if let Some(b) = idx.bangumi.iter_mut().find(|b| b.id == args.bangumi_id) {
            if let Some(slot) = b.episodes.iter_mut().find(|e| e.sort == ep.sort) {
                slot.status = "done".into();
                slot.kind = kind.into();
                slot.segments_done = 1;
                slot.segments_total = 1;
                slot.bytes = bytes;
                slot.error.clear();
                slot.cached_at = now_ms();
                slot.updated_at = now_ms();
            }
        }
    });
    log::info!("[cache] 直链下载完成 {} S{} · {} bytes", args.title, ep.sort, bytes);
    let _ = app.emit("cache-progress", ProgressEvent {
        bangumi_id: args.bangumi_id, sort: ep.sort, title: args.title.clone(),
        status: "done".into(), segments_done: 1, segments_total: 1,
        bytes, bytes_total: bytes, speed: 0.0, error_msg: String::new(),
    });
    cleanup_job(&key);
}

fn emit_fail(app: &tauri::AppHandle, args: &StartArgs, ep: &StartEpisode, msg: &str) {
    log::error!("[cache] 下载失败 {} S{}: {}", args.title, ep.sort, msg);
    let _ = app.emit("cache-progress", ProgressEvent {
        bangumi_id: args.bangumi_id, sort: ep.sort, title: args.title.clone(),
        status: "failed".into(), segments_done: 0, segments_total: 0,
        bytes: 0, bytes_total: 0, speed: 0.0, error_msg: msg.to_string(),
    });
}

async fn mark_failed(ctx: &EpisodeCtx, msg: &str) {
    // 错误信息带线路名，便于前端/用户定位是哪条线路失败
    let full = if ctx.line_name.trim().is_empty() {
        msg.to_string()
    } else {
        format!("[{}] {}", ctx.line_name, msg)
    };
    log::error!("[cache] 下载失败 {} S{}: {}", ctx.title, ctx.sort, full);
    with_index_mut(|idx| {
        if let Some(b) = idx.bangumi.iter_mut().find(|b| b.id == ctx.bangumi_id) {
            if let Some(slot) = b.episodes.iter_mut().find(|e| e.sort == ctx.sort) {
                slot.status = "failed".into();
                slot.error = full.clone();
                slot.updated_at = now_ms();
            }
        }
    });
    let _ = ctx.app.emit("cache-progress", ProgressEvent {
        bangumi_id: ctx.bangumi_id, sort: ctx.sort, title: ctx.title.clone(),
        status: "failed".into(),
        segments_done: ctx.done.load(Ordering::SeqCst) as u64,
        segments_total: ctx.done.load(Ordering::SeqCst) as u64,
        bytes: ctx.bytes_done.load(Ordering::SeqCst) as u64,
        bytes_total: 0, speed: 0.0, error_msg: full,
    });
}

async fn on_cancelled(ctx: &EpisodeCtx) {
    log::info!("[cache] 下载已取消 {} S{}", ctx.title, ctx.sort);
    let _ = std::fs::remove_dir_all(&ctx.ep_dir);
    remove_episode_from_index(ctx.bangumi_id, ctx.sort);
    let _ = ctx.app.emit("cache-progress", ProgressEvent {
        bangumi_id: ctx.bangumi_id, sort: ctx.sort, title: ctx.title.clone(),
        status: "cancelled".into(), segments_done: 0, segments_total: 0,
        bytes: 0, bytes_total: 0, speed: 0.0, error_msg: String::new(),
    });
}

fn cleanup_job(key: &str) {
    take_cancels(key);
}

fn remove_episode_from_index(bangumi_id: i64, sort: i64) {
    with_index_mut(|idx| {
        if let Some(b) = idx.bangumi.iter_mut().find(|b| b.id == bangumi_id) {
            b.episodes.retain(|e| e.sort != sort);
        }
        idx.bangumi.retain(|b| !b.episodes.is_empty());
    });
}

// ─── Tauri 命令 ──────────────────────────────────────────────────────────

/// 应用启动时调用：清理上次运行残留的僵尸「downloading」状态。
///
/// 下载中断（崩溃/强退）后索引中会残留 downloading 条目：
///   * 前端据此把选集按钮禁用 → 用户无法重新下载 → 表现为「无法正常缓存」
///   * 这些条目没有任何活动 worker，必须统一改写为 failed
/// 仅处理状态，不动磁盘文件（分片 .part 会在下次下载时被覆盖）。
pub fn reset_stale_downloads() {
    let n = with_index_mut(|idx| {
        let mut n = 0usize;
        for b in idx.bangumi.iter_mut() {
            for ep in b.episodes.iter_mut() {
                if ep.status == "downloading" {
                    ep.status = "failed".into();
                    ep.error = "上次下载未完成，请重新选择下载".into();
                    ep.updated_at = now_ms();
                    n += 1;
                }
            }
        }
        n
    });
    if n > 0 {
        log::warn!("[cache] 清理上次运行残留的 downloading 状态 {} 条", n);
    }
}

/// 缓存根目录绝对路径
#[tauri::command]
pub fn cache_root_path() -> Result<String, String> {
    cache_root().map(|p| p.to_string_lossy().to_string())
}

/// 读取 JSON 索引（缺失时自动扫盘重建）
#[tauri::command]
pub fn cache_load_index() -> Result<Value, String> {
    let idx = load_index();
    serde_json::to_value(&idx).map_err(|e| e.to_string())
}

/// 强制扫盘重建索引（扫描+写回整体持锁，防与并发下载进度写回交错覆盖）
#[tauri::command]
pub fn cache_rescan_index() -> Result<Value, String> {
    let _guard = index_io_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let idx = scan_disk();
    save_index_locked(&idx)?;
    log::info!("[cache] 重扫磁盘完成：{} 部番剧", idx.bangumi.len());
    serde_json::to_value(&idx).map_err(|e| e.to_string())
}

/// 打开缓存目录（资源管理器）。传番剧名则打开对应番剧文件夹。
#[tauri::command]
pub fn cache_open_dir(app: tauri::AppHandle, bangumi: Option<String>) -> Result<(), String> {
    let root = cache_root()?;
    let dir = match bangumi {
        Some(name) if !name.trim().is_empty() => {
            let dir = bangumi_dir(&root, &name);
            if !dir.exists() {
                std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            dir
        }
        _ => {
            std::fs::create_dir_all(&root).map_err(|e| format!("创建目录失败: {e}"))?;
            root
        }
    };
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("打开目录失败: {e}"))
}

/// 某一集的本地播放文件绝对路径（m3u8 → index.m3u8；直链 mp4 → episode.<ext>，用于本地播放）
#[tauri::command]
pub fn cache_episode_play(bangumi_id: i64, sort: i64) -> Result<String, String> {
    let idx = load_index();
    let b = idx.bangumi.iter().find(|b| b.id == bangumi_id).ok_or("索引中无此番剧")?;
    let ep = b.episodes.iter().find(|e| e.sort == sort).ok_or("索引中无此集")?;
    let root = cache_root()?;
    let dir = root.join(sanitize(&b.title)).join(&ep.dir);
    // 直链缓存（mp4）：kind 标记，或无 index.m3u8（兜底兼容旧索引）
    if ep.kind == "mp4" || !dir.join("index.m3u8").exists() {
        // 1) episode.json 的 file 字段记录的实际文件名（episode.webm 等）
        if let Ok(txt) = std::fs::read_to_string(dir.join("episode.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(f) = v.get("file").and_then(|x| x.as_str()) {
                    if !f.trim().is_empty() {
                        let p = dir.join(f.trim());
                        if p.is_file() {
                            return Ok(p.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        // 2) 兜底：目录内任意 episode.<ext> 文件
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("episode.") && name != "episode.json" && !name.ends_with(".part") {
                    let p = entry.path();
                    if p.is_file() {
                        return Ok(p.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    let p = dir.join("index.m3u8");
    if !p.exists() {
        return Err("缓存文件不存在（可能已被移动或删除）".into());
    }
    Ok(p.to_string_lossy().to_string())
}

/// 开始下载（先选择、后下载）。
///
/// 调度策略（需求：并发下载 —— 同时缓存 N 集，对全部线路类型生效）：
///   * mp4_threads（1–12，默认 3）个 worker 共享游标队列，抢到哪集下哪集，
///     最多 N 集同时下载（即默认「同时缓存三集」）；
///   * 每集内部：直链（MP4 单文件）= 单请求流式写盘；
///     m3u8 = threads（1–32，默认 6）个分片线程并发。
#[tauri::command]
pub fn cache_download_start(app: tauri::AppHandle, args: StartArgs) -> Result<(), String> {
    if args.episodes.is_empty() {
        return Err("未选择任何集数".into());
    }
    // m3u8 下载线程数：默认 6，限制 1–32（每集内部分片并发数）
    let threads = args.threads.unwrap_or(6).clamp(1, 32);
    // 并发下载集数：默认 3（同时缓存三集），限制 1–12；全部线路类型通用
    let mp4_threads = args.mp4_threads.unwrap_or(3).clamp(1, 12);
    log::info!("[cache] 开始下载批次 {} · {} 集 · 分片线程={} · 并发集数={}", args.title, args.episodes.len(), threads, mp4_threads);
    // 索引预登记番剧信息（持锁读改写）
    with_index_mut(|idx| {
        ensure_bangumi(idx, args.bangumi_id, &args.title, &args.cover, args.total_episodes);
    });
    // 新批次：重建番剧级取消标志（覆盖旧标志，保证新下载不受历史取消影响）
    let batch_cancel = Arc::new(AtomicBool::new(false));
    batches().lock().unwrap().insert(args.bangumi_id, batch_cancel.clone());
    let _ = app.emit("cache-progress", ProgressEvent {
        bangumi_id: args.bangumi_id, sort: args.episodes[0].sort, title: args.title.clone(),
        status: "downloading".into(), segments_done: 0, segments_total: 0,
        bytes: 0, bytes_total: 0, speed: 0.0, error_msg: String::new(),
    });
    // ── 统一并发集数池：m3u8 / MP4 全部按「同时缓存 N 集」并发下载 ──
    // （修复：此前 m3u8 逐集串行，表现为「每次只能集中下载一集的 ts 文件或
    //   MP4」。现在 mp4_threads 个 worker 共享一个游标队列，抢到哪集下哪集；
    //   每集内部：直链 = 单请求流式写盘，m3u8 = threads 个分片线程并发。）
    let eps = Arc::new(args.episodes.clone());
    let cursor = Arc::new(AtomicUsize::new(0));
    for _ in 0..mp4_threads {
        let app = app.clone();
        let args = args.clone();
        let eps = eps.clone();
        let cursor = cursor.clone();
        let batch_cancel = batch_cancel.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if batch_cancel.load(Ordering::Relaxed) {
                    return;
                }
                let i = cursor.fetch_add(1, Ordering::SeqCst);
                if i >= eps.len() {
                    return;
                }
                let ep = eps[i].clone();
                if is_video_url(&ep.url) {
                    download_episode_direct(app.clone(), args.clone(), ep, batch_cancel.clone()).await;
                } else {
                    download_episode_hls(app.clone(), args.clone(), ep, threads, batch_cancel.clone()).await;
                }
            }
        });
    }
    Ok(())
}

/// 取消下载（sort 为空则取消该番剧全部任务）
#[tauri::command]
pub fn cache_download_cancel(bangumi_id: i64, sort: Option<i64>) -> Result<(), String> {
    log::info!("[cache] 请求取消下载 bangumi_id={} sort={:?}", bangumi_id, sort);
    let jobs = jobs();
    let mut map = jobs.lock().unwrap();
    match sort {
        Some(s) => {
            if let Some(flags) = map.get_mut(&job_key(bangumi_id, s)) {
                for f in flags { f.store(true, Ordering::Relaxed); }
            }
        }
        None => {
            // 番剧级批量取消：同时置批次标志（拦住尚未开始的集数）
            if let Some(flag) = batches().lock().unwrap().get(&bangumi_id) {
                flag.store(true, Ordering::Relaxed);
            }
            let prefix = format!("{bangumi_id}:");
            for (k, flags) in map.iter_mut() {
                if k.starts_with(&prefix) {
                    for f in flags { f.store(true, Ordering::Relaxed); }
                }
            }
        }
    }
    Ok(())
}

/// 缓存弹幕保存（需求：本地缓存增加缓存弹幕）。
/// 前端在开始下载时拉取多源弹幕并序列化为 JSON 传入；
/// 目录与视频下载一致：data\anime\[番剧]\[NN-集名]\danmaku.json。
/// 注意：调用发生在下载批次刚创建、该集可能尚未登记进索引时，
/// 因此按「番剧名 + 集名 + 集数」直接推导目录（与 ep_dir_name 规则一致），
/// 不依赖索引条目。
#[tauri::command]
pub fn cache_danmaku_save(bangumi_id: i64, title: String, sort: i64, ep_title: String, json: String) -> Result<(), String> {
    let _ = bangumi_id; // 预留：便于以后按 id 校验
    let root = cache_root()?;
    let dir = bangumi_dir(&root, &title).join(ep_dir_name(sort, &ep_title));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    log::info!("[cache] 保存弹幕 {} S{} · {} KB", title, sort, json.len() / 1024);
    std::fs::write(dir.join("danmaku.json"), json.as_bytes())
        .map_err(|e| format!("写入弹幕失败: {e}"))
}

/// 缓存弹幕读取（本地播放时加载；无缓存返回 None）。
/// 优先走索引定位集目录；集目录缺失/未登记时在番剧目录内按
/// 「NN- 前缀」扫描含 danmaku.json 的子目录兜底。
#[tauri::command]
pub fn cache_danmaku_load(bangumi_id: i64, sort: i64) -> Result<Option<String>, String> {
    let idx = load_index();
    let root = cache_root()?;
    let b = match idx.bangumi.iter().find(|b| b.id == bangumi_id) {
        Some(b) => b,
        None => return Ok(None),
    };
    let bdir = bangumi_dir(&root, &b.title);
    // 1) 索引中登记的集目录
    if let Some(ep) = b.episodes.iter().find(|e| e.sort == sort) {
        if !ep.dir.is_empty() {
            let p = bdir.join(&ep.dir).join("danmaku.json");
            if p.is_file() {
                return Ok(std::fs::read_to_string(&p).ok());
            }
        }
    }
    // 2) 兜底：按 NN- 前缀扫描番剧目录
    let prefix = format!("{sort:02}-");
    if let Ok(rd) = std::fs::read_dir(&bdir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                let p = entry.path().join("danmaku.json");
                if p.is_file() {
                    return Ok(std::fs::read_to_string(&p).ok());
                }
            }
        }
    }
    Ok(None)
}

/// 删除缓存（sort 为空则删除整部番剧目录；索引修改持锁，防与并发下载写回交错）
#[tauri::command]
pub fn cache_delete(bangumi_id: i64, sort: Option<i64>) -> Result<(), String> {
    log::info!("[cache] 删除缓存 bangumi_id={} sort={:?}", bangumi_id, sort);
    with_index_mut(|idx| -> Result<(), String> {
        let root = cache_root()?;
        match sort {
            Some(s) => {
                if let Some(b) = idx.bangumi.iter_mut().find(|b| b.id == bangumi_id) {
                    if let Some(ep) = b.episodes.iter().find(|e| e.sort == s) {
                        let dir = root.join(sanitize(&b.title)).join(&ep.dir);
                        if dir.exists() {
                            std::fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
                        }
                    }
                    b.episodes.retain(|e| e.sort != s);
                }
            }
            None => {
                if let Some(pos) = idx.bangumi.iter().position(|b| b.id == bangumi_id) {
                    let b = idx.bangumi[pos].clone();
                    let dir = root.join(sanitize(&b.title));
                    if dir.exists() {
                        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
                    }
                    idx.bangumi.remove(pos);
                }
            }
        }
        idx.bangumi.retain(|b| !b.episodes.is_empty());
        save_index_locked(idx)?;
        Ok(())
    })
}
