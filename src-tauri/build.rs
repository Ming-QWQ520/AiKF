// AiKF build script (v0.1.0)
//
// 与 Zephyr-Music 相同的前端目录约定，build.rs 保持 Tauri 2 默认形态：
//   * 开发模式（pnpm tauri dev）：页面由 vite dev server (http://localhost:1420) 提供，无需 dist
//   * 正式打包（pnpm tauri build）：beforeBuildCommand 先执行 pnpm build 自动生成 ../dist
// 因此此处不做任何 dist 占位/校验，也不输出 cargo:warning。

fn main() {
    tauri_build::build()
}
