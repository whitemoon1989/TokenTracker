# TokenTracker 项目构建参考文档 (Build Guide)

本文档详细说明了 TokenTracker 项目（包括 Web/Dashboard、CLI 后端、Windows 客户端及 macOS 客户端）的构建流程与配置说明。

---

## 一、环境准备 (Prerequisites)

在构建本项目之前，请确保您的开发环境满足以下要求：

* **Node.js**: `≥ 20.0.0` (推荐 LTS 版本)
* **npm**: `≥ 10.0.0`
* **.NET SDK**: `.NET 8.0 SDK`（用于构建 Windows 客户端 `TokenTrackerWin`）
* **Inno Setup 6**: （可选，用于生成 Windows 安装包 `Setup.exe`）
* **Xcode & XcodeGen**: （仅 macOS 端 `TokenTrackerBar` 构建需要）

---

## 二、开发模式构建 (Development Build)

开发模式下可以快速编译和调试项目的各个模块。

### 1. Dashboard 前端开发服务
```bash
npm run dashboard:dev
```
* **说明**：启动 Vite 开发服务器（默认端口 `5173`），内置 Mock 数据，支持热重载。

### 2. CLI 后端本地运行
```bash
node bin/tracker.js serve
```
* **说明**：在本地启动 HTTP API 服务（默认端口 `7680`）。

### 3. Windows 客户端 (开发/Release 模式构建)
若要在开发过程中直接运行 `TokenTrackerWin/bin/Release` 下的程序，需要先编译包含桌面桌宠（`pet.html`）的前端页面：

```powershell
# 1. 编译包含桌宠 (pet.html) 的 Dashboard 静态文件
$env:TOKENTRACKER_BUILD_PET = "1"; npm run dashboard:build

# 2. 编译 Windows Release 模式
dotnet build TokenTrackerWin/TokenTrackerWin.csproj -c Release
```

* **输出位置**：`TokenTrackerWin/bin/Release/net8.0-windows10.0.19041.0/TokenTracker.exe`
* **运行机制**：在开发环境下直接启动该 `TokenTracker.exe`，程序会自动寻找仓库根目录中的 `bin/tracker.js` 并启动本地 CLI 及前端界面。

---

## 三、生产环境独立发布 (Production Release Build)

生产环境发布会将 CLI 运行时、Node.js 二进制以及 Dashboard 网页文件全部嵌入包装到客户端中，生成无依赖（Self-contained）的可执行程序或安装包。

### 1. Windows 独立客户端打包流程 (Self-Contained)

在 PowerShell 中依次执行以下命令：

```powershell
# 步骤 1：设置云端配置环境变量并编译前端（含桌宠页面）
$env:VITE_INSFORGE_BASE_URL = "https://srctyff5.us-east.insforge.app"
$env:VITE_INSFORGE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY"
$env:TOKENTRACKER_BUILD_PET = "1"
npm run dashboard:build

# 步骤 2：打包 EmbeddedServer (自动下载固定版本的 Node.js v22 并整合 CLI 资源)
powershell -ExecutionPolicy Bypass -File TokenTrackerWin/scripts/bundle-node.ps1

# 步骤 3：发布独立运行的 Windows .NET 8 可执行文件
dotnet publish TokenTrackerWin/TokenTrackerWin.csproj -c Release -r win-x64 --self-contained true -o TokenTrackerWin/publish

# 步骤 4：将 EmbeddedServer 放置在可执行程序同级目录下
Copy-Item TokenTrackerWin/EmbeddedServer TokenTrackerWin/publish/EmbeddedServer -Recurse -Force
```

* **最终发布目录**：`TokenTrackerWin/publish/`
* **打包压缩包 (Zip)**：
  ```powershell
  Compress-Archive -Path TokenTrackerWin/publish/* -DestinationPath "TokenTracker-win-x64.zip" -CompressionLevel Optimal
  ```
* **打包安装程序 (Setup.exe)**：
  ```powershell
  & "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DMyAppVersion=0.83.0 TokenTrackerWin\installer\TokenTracker.iss
  ```

---

## 四、关键构建注意事项 (Important Notes)

1. **桌宠页面 (`pet.html`) 构建开关**：
   * 必须添加环境变量 `TOKENTRACKER_BUILD_PET=1` 才能在 `dashboard/dist/` 中构建出 `pet.html`。
   * 这是为了保证 macOS / Web 端与 Windows 端的打包产物保持独立与干净。

2. **Windows 端口回避**：
   * CLI 默认使用 `7680` 端口，在 Windows 上该端口经常会被系统服务 `DoSvc` (Delivery Optimization) 占用。
   * `TokenTrackerWin` 客户端默认会优先绑定 OAuth 允许的固定端口 `17680`，若被占用则使用动态回环端口。

3. **版本号同步**：
   * 项目以 `package.json` 中的 `version` 为唯一事实来源。
   * 修改版本号后运行以下命令可自动同步到 `TokenTrackerWin.csproj` 与 `project.yml`：
     ```bash
     npm run sync-versions
     ```
