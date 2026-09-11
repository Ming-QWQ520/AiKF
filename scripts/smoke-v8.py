#!/usr/bin/env python3
"""AiKF v8 冒烟：选集弹层恢复旧样式+外部点击关闭 / 锁定显示鼠标 / 线路 MP4 chip"""
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = f"{ROOT}/.shots-v8"
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

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1280, "height": 760})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto("http://localhost:4173", wait_until="networkidle")

        # ── 搜索 → 详情 → 播放 ──
        pg.locator("aside").get_by_text("搜索", exact=True).click()
        time.sleep(1)
        pg.locator("input[placeholder*='搜索']").last.fill("冒烟")
        pg.keyboard.press("Enter")
        pg.wait_for_selector("main button.group", timeout=15000)  # 主区真实卡片(排除侧栏导航项)
        time.sleep(1.2)  # 等 GSAP 入场动画结束
        pg.locator("main button.group").first.evaluate("el => el.click()")  # JS click 绕过动画/命中检测
        pg.wait_for_selector("text=立即播放", timeout=15000)
        time.sleep(0.8)
        pg.locator("text=立即播放").first.click()
        pg.wait_for_selector(".aikf-overlay-host", timeout=15000)
        time.sleep(2.5)  # 等 art 初始化 + vod 源就绪

        # ── 1. 收起面板 → 点底栏「选集」→ 旧式弹层 ──
        pg.locator(".aikf-edge-toggle").click()
        time.sleep(0.6)
        check("面板收起(edge-toggle)", pg.locator(".aikf-side").is_visible() is False)
        pg.locator(".art-control-aikf-episodes").click()
        pg.wait_for_selector(".aikf-panel-ep", timeout=5000)
        time.sleep(0.4)
        check("选集弹层可见(旧式浮层)", pg.locator(".aikf-panel-ep").is_visible())
        title_txt = pg.locator(".aikf-panel-ep .aikf-panel-title").inner_text()
        check("弹层标题行为「选集」文本", "选集" in title_txt, f"got={title_txt!r}")
        view_btn = pg.locator(".aikf-panel-ep [title='在右侧面板中查看']")
        close_btn = pg.locator(".aikf-panel-ep [title='关闭']")
        check("头部含「在右侧面板中查看」键", view_btn.count() == 1)
        check("头部含「关闭」键", close_btn.count() == 1)
        pg.screenshot(path=f"{SHOTS}/ep-popup-legacy.png")

        # ── 2. 点击弹层外部区域 → 弹层退出 ──
        pg.locator(".aikf-locked-anchor").count()  # noop
        pg.mouse.click(300, 300)  # 视频区中部（弹层外）
        time.sleep(0.5)
        check("点击弹层外部区域关闭弹层", pg.locator(".aikf-panel-ep").count() == 0)

        # ── 3. 重开 → X 关闭 ──
        pg.locator(".art-control-aikf-episodes").click()
        pg.wait_for_selector(".aikf-panel-ep", timeout=5000)
        pg.locator(".aikf-panel-ep [title='关闭']").click()
        time.sleep(0.4)
        check("点「关闭」键退出弹层", pg.locator(".aikf-panel-ep").count() == 0)

        # ── 4. 重开 → 「在右侧面板中查看」→ 面板展开至选集 Tab ──
        pg.locator(".art-control-aikf-episodes").click()
        pg.wait_for_selector(".aikf-panel-ep", timeout=5000)
        pg.locator(".aikf-panel-ep [title='在右侧面板中查看']").click()
        time.sleep(0.6)
        check("「在右侧面板中查看」展开面板", pg.locator(".aikf-side").is_visible())
        check("面板展开后弹层关闭", pg.locator(".aikf-panel-ep").count() == 0)
        ep_tab_on = pg.locator(".aikf-side").get_by_text("选集", exact=True).first
        check("面板跳转选集 Tab", ep_tab_on.is_visible())
        pg.screenshot(path=f"{SHOTS}/panel-ep-tab.png")

        # ── 5. 线路弹层 MP4/m3u8 协议 chip ──
        pg.locator(".art-control-aikf-line").click()
        pg.wait_for_selector(".aikf-panel-line", timeout=5000)
        time.sleep(0.4)
        line_txt = pg.locator(".aikf-panel-line").inner_text()
        check("线路弹层含 m3u8 协议 chip", "m3u8" in line_txt)
        check("线路弹层含 MP4 协议 chip", "MP4" in line_txt)
        pg.screenshot(path=f"{SHOTS}/line-proto-chips.png")
        pg.mouse.click(640, 620)  # 关线路弹层(点击外部)
        time.sleep(0.4)

        # ── 6. 锁定后鼠标可见 ──
        pg.locator(".aikf-lock-btn[aria-label='锁定播放器控制']").click(force=True)
        pg.wait_for_selector(".aikf-locked", timeout=5000)
        time.sleep(0.4)
        cur_locked = pg.locator(".aikf-locked").evaluate("el => getComputedStyle(el).cursor")
        check("锁定态容器 cursor 非 none", cur_locked != "none", f"got={cur_locked}")
        cur_video = pg.locator(".aikf-locked video").first.evaluate("el => getComputedStyle(el).cursor")
        check("锁定态视频元素 cursor 非 none", cur_video != "none", f"got={cur_video}")
        cur_shield = pg.locator(".aikf-lock-shield").evaluate("el => getComputedStyle(el).cursor")
        check("锁定遮罩 cursor 非 none(默认可见)", cur_shield not in ("none",), f"got={cur_shield}")
        pg.screenshot(path=f"{SHOTS}/locked-cursor.png")
        # 解锁恢复
        pg.locator(".aikf-lock-unlock").click(force=True)
        time.sleep(0.4)
        check("解锁退出锁定态", pg.locator(".aikf-locked").count() == 0)

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
