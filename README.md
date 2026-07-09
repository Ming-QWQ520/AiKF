# AiKF · 樱追番

一款基于 Tauri 2 + Vue 3 + Vite 6 + TypeScript 的现代化追番桌面应用，融合 Material Design 3 色调与 Liquid Glass 毛玻璃风格。数据来源为 Anich 逆向 API。

## ✨ 功能特性

### 🏠 首页
- 16:9 大屏轮播图（自动播放 + 手动切换）
- 追番时间表（周日~周六按天查看）
- 今日更新 + 热播榜右侧栏
- 新番速递网格

### 📋 番剧详情
- 封面 + 标题 + 评分 + 元数据 + 标签
- 播放/收藏按钮 + 追番状态管理
- Tab 切换：选集 / 评论 / 相关推荐
- 角色声优展示
- 评论展开回复

### 🎬 播放器
- HLS.js 自定义配置（预加载 + 大缓冲）
- 自定义控制栏（播放/暂停/静音/快进退/全屏）
- 播放源测速 + 手动切换
- 画中画模式（PiP，可拖动）
- 自动保存播放进度
- 自定义标题栏（可拖动窗口）

### 📂 番剧分类
- 类型 / 语言 / 年份 / 类型标签 / 标记 / 排序 六维筛选
- 分页浏览

### 🔍 搜索
- 实时防抖搜索 + 下拉预览
- 热门搜索推荐

### 📚 追番库
- 在看 / 想看 / 看过 / 搁置 / 弃番 状态管理
- 观看进度跟踪 + 10 星评分
- 数据持久化到 localStorage
- 侧边栏追番库展开列表

## 🛠 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 |
| 前端 | Vue 3.5 + Vite 6 + TypeScript 5 |
| 状态管理 | Pinia |
| 样式 | Tailwind CSS 4 + 自定义 Liquid Glass |
| 图标 | lucide-vue-next |
| 视频 | hls.js |
| HTTP | 自定义 Rust 命令 (reqwest) |
| 包管理器 | pnpm |

## 📦 项目结构

```
AiKF/
├── src/
│   ├── lib/anich/        # Anich SDK (protobuf 解码 + API 客户端)
│   │   ├── wire.ts       # protobuf wire 格式解码器
│   │   ├── parsers.ts    # 类型化解析器
│   │   ├── types.ts      # API 模型
│   │   ├── client.ts     # 双模式客户端 (Tauri Rust / 浏览器代理)
│   │   ├── api-client.ts # 带缓存的 API 封装
│   │   ├── cache.ts      # 5 分钟内存缓存
│   │   └── format.ts     # 日期/时长格式化
│   ├── stores/           # Pinia: ui + library (持久化)
│   ├── composables/      # useAsync + useTheme
│   ├── components/       # NavShell, TitleBar, PlayerDialog, ...
│   │   └── views/        # Discover, Calendar, Browse, Search, Library, Detail
│   └── assets/globals.css
├── src-tauri/
│   ├── src/lib.rs        # Rust 后端 (anich_fetch 命令 + 插件注册)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/     # 权限配置
└── package.json
```

## 🚀 开发

```bash
# 安装依赖
pnpm install

# 开发模式（需要 Tauri 环境）
pnpm tauri dev

# 构建
pnpm tauri build
```

### 前置条件

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- WebView2 (Windows 10 1803+ / Windows 11)

## 📜 开源协议

本项目基于 [AGPL-3.0](LICENSE) 协议开源。

## ⚠️ 免责声明

本项目仅供学习交流使用，数据来源为第三方逆向 API。请支持正版番剧。
