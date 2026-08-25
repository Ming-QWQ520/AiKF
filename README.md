# AiKF · 爱看番

一款基于 Tauri 2 + Vue 3 + Vite 6 + TypeScript 的现代化追番桌面应用，融合 Material Design 3 色调、Liquid Glass 毛玻璃风格与 Naive UI 组件库。数据来源为 Anich 逆向 API。

## ✨ 功能特性

### 🏠 首页
- 16:9 大屏轮播图（自动播放 + 手动切换）
- 追番时间表（周日~周六按天查看）
- 今日更新 + 热播榜右侧栏
- 新番速递网格
- 基于 Naive UI 的左侧导航栏（NButton + NTooltip + NBadge + NIcon）
  - 自适应折叠（窄屏自动收起为图标模式）
  - 折叠态自动 tooltip 显示完整名称
  - 追番库数量徽章实时显示
  - 集成 GSAP 流畅过渡动画

### 📋 番剧详情
- 封面 + 标题 + 评分 + 元数据 + 标签
- 播放/收藏按钮 + 追番状态管理
- Tab 切换：选集 / 评论 / 相关推荐
- 角色声优展示
- 评论展开回复

### 🎬 播放器
- HLS.js 自定义配置（预加载 + 大缓冲）
- 基于 Naive UI 的播放控制栏（NButton + NIcon + NTooltip + NSlider）
  - 圆形按钮组：播放/暂停、静音、后退/前进 10 秒、全屏
  - 悬浮提示气泡（NTooltip）显示完整功能名
  - 垂直音量滑块（NSlider）含百分比数字显示
  - 播放源延迟徽章（NTag success/error 状态色）
  - 空状态/错误状态使用 NEmpty 组件
- 播放源测速 + 手动切换（NScrollbar 包裹列表）
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
- 侧边栏追番库展开列表（NButton + NBadge）

## 🛠 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 |
| 前端 | Vue 3.5 + Vite 6 + TypeScript 5 |
| 状态管理 | Pinia |
| 样式 | Tailwind CSS 4 + 自定义 Liquid Glass |
| UI 组件库 | **Naive UI 2.45** |
| 图标 | lucide-vue-next + Naive UI NIcon |
| 视频播放器 | hls.js |
| HTTP | 自定义 Rust 命令 (reqwest) |
| 动画 | GSAP |
| 包管理器 | pnpm |

## 🎨 Naive UI 集成说明

本项目在保留原有 Tailwind + Liquid Glass 视觉风格的基础上，引入 Naive UI 组件库对关键界面进行了重构：

### 已优化的模块

1. **首页左侧导航栏（NavShell.vue）**
   - `NButton` 替换原生 `<button>`，统一 quaternary 模式与圆形/胶囊按钮风格
   - `NIcon` 统一图标尺寸与颜色继承
   - `NBadge` 用于追番库数量徽章
   - `NTooltip` 折叠态下显示完整菜单名

2. **播放界面（PlayerDialog.vue）**
   - `NButton + NIcon + NTooltip` 重构播放控制栏所有按钮
   - `NSlider` 替换原生 `<input type="range">` 实现垂直音量滑块
   - `NTag` 显示播放源延迟测速结果（success/error 状态色）
   - `NScrollbar` 包裹播放源列表，提供原生滚动条美化
   - `NEmpty` 替换无剧集/无播放源空状态
   - 折叠按钮、上下话切换、PiP 浮窗按钮均迁移至 `NButton`

### 主题一致性

Naive UI 通过 CSS 变量与 Tailwind 4 的 `oklch()` MD3 色盘无缝融合：
- 主色（primary）通过 `--primary` 与 Naive UI 的 `primary` 类型同步
- 玻璃态（glass / glass-sheen）通过 `!`-prefix Tailwind utility 覆盖 NButton 默认背景
- 暗色模式通过 `dark` 类自动切换 Naive UI 主题

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
│   ├── main.ts           # 注册 Naive UI + Pinia + GSAP
│   └── assets/globals.css
├── src-tauri/
│   ├── src/lib.rs        # Rust 后端 (anich_fetch 命令 + 插件注册)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/     # 权限配置
├── .github/workflows/    # GitHub Actions CI/CD
└── package.json
```

## 🚀 开发

```bash
# 安装依赖
pnpm install

# 开发模式（需要 Tauri 环境）
pnpm tauri dev

# 仅构建前端（TypeScript 检查 + Vite 打包）
pnpm run build

# 完整构建（含 Tauri 桌面应用打包）
pnpm tauri build
```

### 前置条件

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- WebView2 (Windows 10 1803+ / Windows 11)

## 🔧 GitHub Actions

仓库内置 `.github/workflows/build.yml`，每次推送到 `main` 分支或提交 PR 时自动执行：

1. **前端构建任务** (`build-frontend`)
   - 安装 pnpm + Node.js 20
   - `pnpm install` 安装依赖
   - `pnpm run build` 执行 TypeScript 类型检查与 Vite 打包
   - 上传构建产物 `dist/` 作为 artifact

2. **Tauri 构建任务** (`build-tauri`) — 可选
   - 多平台矩阵构建（Ubuntu / Windows / macOS）
   - 安装系统依赖与 Rust 工具链
   - `pnpm tauri build` 生成桌面安装包
   - 上传 `.deb`/`.rpm`/`.msi`/`.dmg` 作为 release artifact

## 📜 开源协议

本项目基于 [AGPL-3.0](LICENSE) 协议开源。

## ⚠️ 免责声明

本项目仅供学习交流使用，数据来源为第三方逆向 API。请支持正版番剧。
