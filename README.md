<div align="center">

<img src="public/aikf-logo-128.png" width="128" alt="AiKF Logo" />

# AiKF · 爱看番

**基于 Tauri 2 + Vue 3 的桌面番剧播放器**

多线路播放 · 实时弹幕 · 本地缓存 · 亮暗主题

[![Stars](https://img.shields.io/github/stars/Ming-QWQ520/AiKF?style=for-the-badge&logo=github&label=Stars)](https://github.com/Ming-QWQ520/AiKF/stargazers)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3.x-4FC08D?style=for-the-badge&logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-Stable-DEA584?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Vite](https://img.shields.io/badge/Vite-6.x-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.x-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-F9AD00?style=for-the-badge&logo=pnpm&logoColor=white)](https://pnpm.io)
[![License](https://img.shields.io/github/license/Ming-QWQ520/AiKF?style=for-the-badge)](./LICENSE)

</div>

---

## 简介

AiKF（爱看番）是一款 Windows 桌面端番剧播放器，使用 **Tauri 2**（Rust 后端）+ **Vue 3**（TypeScript 前端）构建，体积小、启动快、内存占用低。

应用围绕「追番 → 播放 → 缓存」的完整链路设计：发现页 / 时间表 / 搜索 / 追番库多视图浏览番剧；播放页基于 ArtPlayer 内核，支持 m3u8 与 MP4 直链双协议多线路、自动测速选线与多源弹幕；本地缓存引擎提供 Steam 风格的下载管理页，支持分片多线程与并发集数控制，缓存的番剧连同弹幕一起离线可看。

## 功能特性

### 播放器

- ArtPlayer 5 内核：倍速播放、进度缩略图预览、画面比例调节、网页 / 真全屏
- 小窗播放（画中画）、播放锁定（锁定状态下鼠标光标保持可见）
- 自动连播开关、播放中测速不自动切换线路
- 全局下载坞：任何页面发起缓存后，底部常驻进度条实时显示下载状态

### 线路与播放源

- 支持 **m3u8**（HLS 分片）与 **MP4 直链**两类协议，线路协议角标清晰标注
- 线路自动测速优选（adkwai 优先），支持手动切换节点
- 无资源的集数显示红色「无资源」角标，无可播放源页面提供返回键

### 弹幕

- 多源弹幕合并：站点服务端 + 哔哩哔哩 + 弹弹 Play，自动去重
- 弹幕设置面板：透明度、字号、速度、显示区域、防重叠、同步播放速度

### 本地缓存（Steam 风格下载管理）

- 下载页仿 Steam 下载管理器：顶部指标条（总速度 / 队列 / 磁盘占用）、分区任务列表、绿色进度条、估计剩余时间
- m3u8 分片多线程下载（1–32 线程，默认 6）
- 并发集数控制：同时缓存 1–12 集（默认 3），全协议生效
- MP4 直链单请求流式写盘，按 URL 扩展名落盘
- 缓存弹幕随番剧一并写入本地，离线播放同样有弹幕
- 已完成列表支持单部删除与「清除全部」（二次确认防误删）

### 界面

- 亮色 / 暗色主题一键切换，支持自定义背景（图片 + 透明度 + 模糊）
- 发现 / 时间表 / 搜索 / 追番库 / 浏览多视图，Hero 轮播与骨架屏加载
- 原生窗口标题栏融合，沉浸式观感

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2（Rust） |
| 前端框架 | Vue 3 + TypeScript |
| 构建工具 | Vite 6 · vue-tsc |
| 样式方案 | Tailwind CSS 4 · tw-animate-css |
| 状态管理 | Pinia |
| 播放内核 | ArtPlayer 5 · hls.js · artplayer-plugin-danmuku · artplayer-plugin-auto-thumbnail |
| 组件与图标 | Naive UI · Lucide · @vicons |
| 包管理 | pnpm |

## 快速开始

### 环境要求

- Node.js 20+ 与 pnpm 10+
- Rust stable（含 `x86_64-pc-windows-msvc` target）
- Windows 10 1803+ / Windows 11（系统内置 WebView2 Runtime）

### 本地开发

```bash
# 安装依赖
pnpm install

# 开发模式（前端热更新 + Tauri 窗口）
pnpm tauri dev

# 构建发布版（自动生成安装包 / 可执行文件）
pnpm tauri build

# 仅前端：类型检查 + 生产构建
pnpm build
```

### 冒烟测试（可选）

```bash
# 依赖：Node.js + Python + Playwright
node scripts/mock-server.mjs &        # 本地模拟服务
python scripts/smoke-v11.py           # 无头浏览器回归断言
```

## 项目结构

```text
AiKF/
├─ src/                    # Vue 3 前端源码
│  ├─ components/          # UI 组件（播放器、下载坞、番剧卡片、各视图…）
│  ├─ stores/              # Pinia 状态（cache / library / settings / ui）
│  ├─ lib/                 # API 客户端、弹幕拉取与合并、工具函数
│  └─ assets/              # 全局样式
├─ src-tauri/              # Tauri 2 / Rust 后端
│  ├─ src/cache.rs         # 本地缓存下载引擎（索引、并发池、分片下载）
│  ├─ icons/               # 应用图标
│  └─ tauri.conf.json      # Tauri 配置
├─ public/                 # 静态资源（logo）
├─ scripts/                # Playwright 冒烟回归脚本 + 本地模拟服务
└─ .github/workflows/      # CI：前端构建检查 + Windows 便携版打包
```

## 许可证

本项目基于 [AGPL-3.0](./LICENSE) 协议开源，仅供学习交流使用。
