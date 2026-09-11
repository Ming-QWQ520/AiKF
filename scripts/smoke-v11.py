#!/usr/bin/env python3
"""AiKF v11 冒烟：下载页 Steam 风格重构 + 底栏（删下一集 / 放大设置与小窗播放）"""
import subprocess, time, sys, os, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = f"{ROOT}/.shots-v11"
os.makedirs(SHOTS, exist_ok=True)

ok_count, fail_count = 0, 0
def check(name, cond, extra=""):
    global ok_count, fail_count
    if cond:
        ok_count += 1
        print(f"  PASS  {name}")
    else:
        fail_count += 1
        print(f"  FAIL  {name}  {extra}")

LIB_SEED = {
    "1": {
        "id": 1, "title": "冒烟测试番剧", "image": "",
        "tagline": "", "totalEpisodes": 12, "status": "watching",
        "currentEpisode": 3, "watchedEpisodes": [1, 2, 3], "score": 0,
        "addedAt": 1700000000000, "updatedAt": 1700000000000,
    }
}

mock = subprocess.Popen(["node", f"{ROOT}/scripts/mock-server.mjs"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
prev = subprocess.Popen(["corepack", "pnpm", "preview", "--port", "4173", "--strictPort"], cwd=ROOT,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)

FORCE_CONTROLS = """
() => {
  const p = document.querySelector('.art-video-player');
  if (!p) return false;
  p.classList.add('art-control-show', 'art-hover');
  return true;
}
"""

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1280, "height": 820})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.add_init_script(f"localStorage.setItem('anich-library-v1', JSON.stringify({json.dumps(LIB_SEED)}));")
        pg.goto("http://localhost:4173", wait_until="networkidle")

        # ══ A. 缓存页 Steam 风格（静态） ══
        pg.locator("aside").get_by_text("本地缓存", exact=True).click()
        time.sleep(1.2)
        main_txt = pg.locator("main").inner_text()
        check("Steam 分区标题「即将进行 (N)」", "即将进行" in main_txt)
        check("Steam 分区标题「已完成 (N)」", "已完成" in main_txt)
        check("Steam 指标「网络 · 总速度」", "网络 · 总速度" in main_txt)
        check("Steam 指标「队列 · 下载中」", "队列 · 下载中" in main_txt)
        check("Steam 指标「磁盘占用」", "磁盘占用" in main_txt)
        check("「清除全部」按钮存在", pg.get_by_text("清除全部", exact=True).count() >= 1)
        check("旧「已缓存番剧」统计已移除", "已缓存番剧" not in main_txt)
        check("追番库条目渲染", "冒烟测试番剧" in main_txt)
        pg.screenshot(path=f"{SHOTS}/cache-steam-idle.png")

        # ══ B. 注入下载中任务 → Steam 任务卡 ══
        SEED_LIVE = """
() => {
  const app = document.querySelector('#app').__vue_app__;
  const cache = app.config.globalProperties.$pinia._s.get('cache');
  if (!cache) return false;
  const now = Date.now();
  const mk = (sort, bytes, bytesTotal, speed, segs) => ({
    sort, status: 'downloading', segmentsDone: segs, segmentsTotal: 100,
    bytes, bytesTotal, speed, errorMsg: '', updatedAt: now, title: '冒烟测试番剧',
  });
  cache.live = {
    '1:4': mk(4, 120*1024*1024, 400*1024*1024, 2.4*1024*1024, 30),
    '1:5': mk(5, 40*1024*1024, 350*1024*1024, 1.1*1024*1024, 12),
    '1:6': mk(6, 0, 0, 0, 0),
  };
  // 同步注入一条已完成番剧（驱动「已完成」区与清除全部按钮可用态）
  cache.bangumi = [{
    id: 1, title: '冒烟测试番剧', cover: '', total_episodes: 12,
    episodes: [{
      sort: 1, title: '第1话', dir: 'x', status: 'done', kind: 'hls',
      segments_done: 100, segments_total: 100, bytes: 300*1024*1024,
      duration_sec: 1420, resolution: '1080P', line_name: 'adkwai',
      error: '', cached_at: Date.now(), updated_at: Date.now(),
    }],
    updated_at: Date.now(),
  }];
  return true;
}
"""
        check("pinia 注入 live 任务", pg.evaluate(SEED_LIVE))
        time.sleep(1.0)
        main_txt = pg.locator("main").inner_text()
        check("「下载中」分区出现", "下载中" in main_txt)
        check("「正在下载数据」进度行", "正在下载数据" in main_txt)
        check("「估计剩余时间」显示", "估计剩余时间" in main_txt)
        check("当前话标题显示（第4话）", "第4话" in main_txt)
        check("每集迷你进度（04/05/06）", all(t in main_txt for t in ("04", "05", "06")))
        fills = pg.locator("main .from-emerald-500").count()
        check("Steam 绿色渐变进度条渲染", fills >= 4, f"count={fills}")
        check("全局下载坞可见", pg.locator("[data-aikf-dock]").count() == 1)
        pg.screenshot(path=f"{SHOTS}/cache-steam-downloading.png")

        # ══ B2. 已完成区 Steam 行 + 清除全部二次确认 ══
        main_txt = pg.locator("main").inner_text()
        check("已完成行「已下载 1 / 12 集」", "已下载" in main_txt and "1 / 12 集" in main_txt.replace("\n", ""))
        check("已完成行「完成于：今天」", "完成于：今天" in main_txt)
        clear_btn = pg.get_by_text("清除全部", exact=True).first
        check("清除全部按钮可用（有已完成条目）", clear_btn.is_enabled())
        clear_btn.click()
        time.sleep(0.4)
        check("清除全部 → 二次确认文案", "删除全部" in pg.locator("main").inner_text())
        pg.get_by_text("取消", exact=True).first.click()
        time.sleep(0.3)
        check("清除全部可取消", pg.get_by_text("清除全部", exact=True).count() == 1)
        pg.screenshot(path=f"{SHOTS}/cache-steam-completed.png")

        # ══ C. 播放器底栏：删「下一集」+ 放大「设置」「小窗播放」 ══
        pg.locator("aside").get_by_text("搜索", exact=True).click()
        time.sleep(1)
        pg.locator("input[placeholder*='搜索']").last.fill("冒烟")
        pg.keyboard.press("Enter")
        pg.wait_for_selector("main button.group", timeout=15000)
        time.sleep(1.2)
        pg.locator("main button.group", has_text="冒烟测试番剧").first.evaluate("el => el.click()")
        pg.wait_for_selector("text=立即播放", timeout=15000)
        time.sleep(0.8)
        pg.locator("text=立即播放").first.click()
        pg.wait_for_selector(".aikf-overlay-host", timeout=15000)
        time.sleep(2.5)
        pg.evaluate(FORCE_CONTROLS)
        time.sleep(0.3)

        check("「下一集」按键已移除", pg.locator(".art-control-aikf-next").count() == 0)
        check("设置按键存在且 tooltip=设置", pg.locator('.art-control-aikf-settings[aria-label="设置"]').count() == 1)
        check("小窗按键存在且 tooltip=小窗播放", pg.locator('.art-control-aikf-mini[aria-label="小窗播放"]').count() == 1)
        sizes = pg.evaluate("""
() => {
  const g = document.querySelector('.art-control-aikf-settings .aikf-gear-btn');
  const m = document.querySelector('.art-control-aikf-mini .aikf-mini-btn');
  if (!g || !m) return null;
  const r = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
  return { gear: r(g), mini: r(m) };
}
""")
        check("设置按键放大至 30×30", bool(sizes) and sizes["gear"]["w"] == 30 and sizes["gear"]["h"] == 30, str(sizes))
        check("小窗按键放大至 30×30", bool(sizes) and sizes["mini"]["w"] == 30 and sizes["mini"]["h"] == 30, str(sizes))
        pg.screenshot(path=f"{SHOTS}/player-bar.png")

        # 设置弹层回归：仍可正常打开
        pg.locator(".art-control-aikf-settings").first.evaluate("el => el.click()")
        time.sleep(0.5)
        check("设置弹层仍正常打开", pg.locator(".aikf-panel-settings").count() == 1)
        pg.locator(".aikf-pop-shield").first.click(position={"x": 90, "y": 110})
        time.sleep(0.4)
        check("设置弹层遮罩关闭回归", pg.locator(".aikf-panel-settings").count() == 0)

        # 选集按键回归（弹层分流）
        pg.evaluate(FORCE_CONTROLS)
        edge = pg.locator(".aikf-edge-toggle")
        if edge.count() > 0:
            edge.first.evaluate("el => el.click()")
            time.sleep(0.6)
        pg.locator(".art-control-aikf-episodes").first.evaluate("el => el.click()")
        time.sleep(0.6)
        check("选集弹层回归（旧式浮层）", pg.locator(".aikf-panel-ep").count() == 1)
        pg.screenshot(path=f"{SHOTS}/player-ep-popup.png")

        real_errors = [e for e in errors if "HLS" not in e and "hls" not in e and "demuxer" not in e.lower()]
        check("console 无非预期报错", len(real_errors) == 0, f"{real_errors[:2]}")
        browser.close()

except Exception:
    import traceback
    traceback.print_exc()
    fail_count += 1
finally:
    mock.terminate(); prev.terminate()
    print(f"\n═══ 结果: {ok_count} PASS / {fail_count} FAIL ═══")
    sys.exit(1 if fail_count else 0)
