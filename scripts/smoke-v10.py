#!/usr/bin/env python3
"""AiKF v10 冒烟：弹层遮罩统一（线路/设置/弹幕/选集）+ 点击不穿透播放 + 并发集数文案"""
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = f"{ROOT}/.shots-v10"
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
prev = subprocess.Popen(["corepack", "pnpm", "preview", "--port", "4173", "--strictPort"], cwd=ROOT,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)

# 在 video 元素上安装 play/pause 调用间谍：任何穿透到播放器的暂停/切换都会计数
SPY = """
() => {
  const v = document.querySelector('.art-video-player video');
  if (!v) return false;
  window.__spies = { play: 0, pause: 0 };
  const op = v.play.bind(v), pa = v.pause.bind(v);
  v.play = () => { window.__spies.play++; return op(); };
  v.pause = () => { window.__spies.pause++; return pa(); };
  return true;
}
"""
SPIES_OK = "() => window.__spies && window.__spies.play === 0 && window.__spies.pause === 0"
FORCE_CONTROLS = """
() => {
  const p = document.querySelector('.art-video-player');
  if (!p) return false;
  p.classList.add('art-control-show', 'art-hover');
  return true;
}
"""

def open_panel(pg, control_sel, panel_sel, name):
    """点底栏按键 → 弹层出现 + 通用遮罩存在"""
    pg.locator(control_sel).first.evaluate("el => el.click()")
    time.sleep(0.5)
    opened = pg.locator(panel_sel).count() == 1
    shield = pg.locator(".aikf-pop-shield").count() == 1
    check(f"{name}：底栏按键打开弹层", opened)
    check(f"{name}：弹层带透明遮罩", shield)
    return opened and shield

def shield_close_no_toggle(pg, panel_sel, name):
    """点遮罩空白处 → 弹层关闭 + play/pause 零调用（不穿透）"""
    before = pg.evaluate("() => ({...window.__spies})")
    pg.locator(".aikf-pop-shield").first.click(position={"x": 90, "y": 110})
    time.sleep(0.4)
    closed = pg.locator(panel_sel).count() == 0 and pg.locator(".aikf-pop-shield").count() == 0
    check(f"{name}：点击遮罩关闭弹层", closed)
    after = pg.evaluate("() => ({...window.__spies})")
    check(f"{name}：遮罩点击不触发 播放/暂停（{before['play']},{before['pause']} → {after['play']},{after['pause']}）",
          after["play"] == before["play"] and after["pause"] == before["pause"])

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1280, "height": 760})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto("http://localhost:4173", wait_until="networkidle")

        # ── A. 缓存页文案：MP4 线程 → 并发集数 ──
        pg.locator("aside").get_by_text("本地缓存", exact=True).click()
        time.sleep(1.2)
        cache_txt = pg.locator("main").inner_text()
        check("页头统计改为「并发集数」", "并发集数" in cache_txt and "MP4 线程" not in cache_txt)
        check("提示文案含「并发 1–12 集」", "并发 1–12 集" in cache_txt)

        # ── B. 播放器弹层遮罩（线路/设置/弹幕）──
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
        check("播放器初始化", pg.locator(".aikf-overlay-host").count() == 1)
        check("play/pause 间谍安装", pg.evaluate(SPY))
        pg.evaluate(FORCE_CONTROLS)
        time.sleep(0.3)

        for control_sel, panel_sel, name in [
            (".art-control-aikf-line", ".aikf-panel-line", "线路弹层"),
            (".art-control-aikf-settings", ".aikf-panel-settings", "设置弹层"),
            (".art-control-aikf-danmaku", ".aikf-panel-danmaku", "弹幕弹层"),
        ]:
            if open_panel(pg, control_sel, panel_sel, name):
                # 弹层本体点击不应关闭、不应穿透（点面板标题区域）
                pg.locator(panel_sel).first.click(position={"x": 30, "y": 12})
                time.sleep(0.3)
                still = pg.locator(panel_sel).count() == 1
                check(f"{name}：点击弹层本体不关闭", still)
                untouched = pg.evaluate(SPIES_OK)
                check(f"{name}：弹层本体点击不穿透播放", untouched)
                shield_close_no_toggle(pg, panel_sel, name)
                pg.evaluate(FORCE_CONTROLS)
        pg.screenshot(path=f"{SHOTS}/panels-shield.png")

        # ── C. 选集弹层（面板收起态）：遮罩 + 不穿透 ──
        pg.evaluate(FORCE_CONTROLS)
        edge = pg.locator(".aikf-edge-toggle")
        if edge.count() > 0:
            edge.first.evaluate("el => el.click()")
            time.sleep(0.6)
        pg.locator(".art-control-aikf-episodes").first.evaluate("el => el.click()")
        time.sleep(0.6)
        ep_open = pg.locator(".aikf-panel-ep").count() == 1 and pg.locator(".aikf-ep-shield").count() == 1
        check("选集弹层打开 + 旧式遮罩存在", ep_open)
        pg.locator(".aikf-ep-shield").first.click(position={"x": 90, "y": 110})
        time.sleep(0.4)
        check("选集弹层：点击遮罩关闭", pg.locator(".aikf-panel-ep").count() == 0 and pg.locator(".aikf-ep-shield").count() == 0)
        check("选集弹层：遮罩点击不穿透播放", pg.evaluate(SPIES_OK))
        pg.screenshot(path=f"{SHOTS}/ep-popup-shield-closed.png")

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
