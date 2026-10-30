# Klaus 桌面端

[English](README.md) · [官网](https://klaus-ai.cn) · [引擎](https://github.com/meitianwang/klaus-engine)

Klaus 是一个 AI 智能体桌面应用：在对话里调用工具处理项目文件、操作浏览器、执行多步任务，每一步都受明确的权限约束。本仓库是 Electron 桌面客户端；Rust 智能体引擎在 [klaus-engine](https://github.com/meitianwang/klaus-engine)，以子模块挂在这里。

## 仓库内容

- `main/`、`preload/`、`shared/`：Electron 宿主，负责会话、IPC、权限、扩展，以及它独占的引擎进程。
- `frontend/`：桌面界面。
- `native/`：原生扩展与各平台助手（语音、录屏、画中画、Computer Use）。
- `engine/klaus-agent-rust`：引擎子模块；`engine/scripts/` 负责开发与打包时准备引擎。
- `resources/`：随应用发布的资源，包括内置插件、Canvas 配方、工作区运行时和用户手册。
- `contracts/`：已提交的契约向量，钉住宿主与引擎之间的线协议行为。
- `packaging/`、`scripts/`：打包、校验与测试入口。

## 环境要求

- Git、Node.js 22.12 及以上、npm；前端测试需要 Bun。
- Rust 与 Cargo（工具链版本见 `rust-toolchain.toml`）。
- 原生构建工具：macOS 需要 Xcode Command Line Tools，Windows 需要 Visual Studio Build Tools。

## 构建与运行

```sh
git clone --recurse-submodules https://github.com/meitianwang/klaus-open-source.git klaus-desktop
cd klaus-desktop
npm ci
./dev.sh --profile="$HOME/.klaus-desktop-dev"     # Windows：dev.bat --profile="%USERPROFILE%\.klaus-desktop-dev"
```

启动器会准备前端、宿主、引擎和原生助手，然后打开开发窗口。首次构建引擎和原生部分需要一些时间。显式指定 profile 可以让这份检出和已安装的 Klaus 互不影响。

## 配置

- **发行版本**：应用标识、产品名、服务地址、数据目录等身份信息以数据形式写在 `contracts/desktop-editions.json`。开发或打包时可以用 `KLAUS_DESKTOP_EDITIONS_FILE` / `--editions-file` 额外提供版本定义；打包后的应用只携带它自己的定义。
- **服务地址**：默认版本指向托管的 Klaus 服务。设置 `KLAUS_SERVER_URL` 可以改用你自己的服务端。
- **官方插件**：部分第一方插件单独分发。开发启动时可以用 `KLAUS_OFFICIAL_PLUGINS_DIR` 指向插件市场目录加载它们；打包时只有传入 `--official-plugins-dir` 和 `--bundle-official-plugin` 才会内置。

## 测试

```sh
npm run typecheck && npm run typecheck:frontend
npm run test:frontend                 # bun
npm run test:host                     # 在 Electron 的 Node 运行时下跑宿主测试
node scripts/test-packaging.mjs       # 打包
npm test                              # 聚合门禁（会构建引擎与原生扩展）
```

GUI 测试启动 Electron 前会先检查系统权限（`node scripts/electron-test-preflight.cjs`）。

## 许可证

本项目自有代码采用 MIT 许可证（见 [LICENSE](LICENSE)）。随附的第三方内容保留各自的许可证，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。所集成服务的产品名称与标志归各自所有者。
