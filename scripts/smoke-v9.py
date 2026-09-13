#!/usr/bin/env python3
"""AiKF v9 冒烟：剧集页「无资源」角标 / 无源态返回键 / MP4 下载线程设置"""
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = f"{ROOT}/.shots-v9"
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

mock = subprocess.Popen(["node", f"{ROOT}/scripts/mock-server.mjs"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
prev = subprocess.Popen(["pnpm", "preview", "--port", "4173", "--strictPort"], cwd=ROOT,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1280, "height": 760})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto("http://localhost:4173", wait_until="networkidle")

        # ── A. 搜索「无资源」→ 详情 → 剧集 Tab：「无资源」角标 ──
        pg.locator("aside").get_by_text("搜索", exact=True).click()
        time.sleep(1)
        pg.locator("input[placeholder*='搜索']").last.fill("无资源")
        pg.keyboard.press("Enter")
        pg.wait_for_selector("main button.group", timeout=15000)
        time.sleep(1.2)
        pg.locator("main button.group", has_text="无资源测试番剧").first.evaluate("el => el.click()")
        pg.wait_for_selector("text=立即播放", timeout=15000)
        time.sleep(0.8)
        # 切到剧集 Tab
        pg.get_by_role("button", name="剧集", exact=True).click()
        time.sleep(1.2)
        body = pg.locator("body").inner_text()
        check("剧集页显示「无资源」角标", "无资源" in body)
        check("剧集页不再误标「有资源」", "有资源" not in body)
        pg.screenshot(path=f"{SHOTS}/detail-no-res-badge.png")

        # ── B. 点击立即播放 → 无源态 → 返回键 ──
        pg.locator("text=立即播放").first.click()
        pg.wait_for_selector("text=暂无可用的播放源", timeout=15000)
        time.sleep(0.6)
        back_btn = pg.locator("button", has_text="返回")
        check("无源态出现「返回」键", back_btn.count() >= 1)
        check("无源态出现「重试」键", pg.locator("button", has_text="重试").count() >= 1)
        pg.screenshot(path=f"{SHOTS}/player-no-source-back.png")
        back_btn.first.click()
        time.sleep(1.0)
        check("点「返回」关闭播放器回到详情页", pg.locator("text=暂无可用的播放源").count() == 0 and pg.locator("text=立即播放").count() > 0)

        # ── C. 本地缓存页：MP4 线程设置（收藏已在 B 步 handlePlay→ensureEntry 自动完成）──
        time.sleep(0.5)
        pg.locator("aside").get_by_text("本地缓存", exact=True).click()
        time.sleep(1.2)
        cache_txt = pg.locator("main").inner_text()
        check("页头统计含「MP4 线程」", "MP4 线程" in cache_txt)
        # 展开追番库条目
        pg.get_by_role("button", name="展开选集").first.click()
        time.sleep(1.5)
        bar_txt = pg.locator("main").inner_text()
        check("操作条含「MP4 线程 (1–12)」", ("MP4 线程" in bar_txt and "(1–12)" in bar_txt))
        check("操作条含「m3u8 线程 (1–32)」", "(1–32)" in bar_txt)
        pg.screenshot(path=f"{SHOTS}/cache-mp4-threads.png")

        # ── D. 回归：正常番剧播放链路不受影响 ──
        pg.locator("aside").get_by_text("搜索", exact=True).click()
        time.sleep(1)
        pg.locator("input[placeholder*='搜索']").last.fill("冒烟")
        pg.keyboard.press("Enter")
        pg.wait_for_selector("main button.group", timeout=15000)
        time.sleep(1.2)
        pg.locator("main button.group", has_text="冒烟测试番剧").first.evaluate("el => el.click()")
        pg.wait_for_selector("text=立即播放", timeout=15000)
        time.sleep(0.8)
        # 正常番剧剧集 Tab 全部「有资源」
        pg.get_by_role("button", name="剧集", exact=True).click()
        time.sleep(1.2)
        eps_txt = pg.locator("body").inner_text()
        check("正常番剧剧集页显示「有资源」", "有资源" in eps_txt)
        pg.locator("text=立即播放").first.click()
        pg.wait_for_selector(".aikf-overlay-host", timeout=15000)
        time.sleep(2.0)
        check("正常番剧播放器正常初始化", pg.locator(".aikf-overlay-host").count() == 1)
        pg.screenshot(path=f"{SHOTS}/regression-play-ok.png")

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
