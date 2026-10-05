# 开发指南

[返回 README](../README.md)

## 环境与运行

- Node.js 22+、npm。
- 手机实际录音使用可信 HTTPS；Windows 一键启动会准备所需工具和证书。
- 浏览器回归默认使用已安装的 Google Chrome；Playwright 已列入开发依赖。

```sh
npm ci
npm run dev
```

`npm start` 正常运行服务，`npm run dev` 在服务代码变化时重启。默认地址为 `http://localhost:8787`，接收页为 `/receiver`。手动启动不会自动读取 `.env`，配置方法见[部署指南](deployment.md)。

## 目录与源码约定

```text
client/                  电脑接收端 HTML / JavaScript 源码
html/dist/               手机端源码、共享静态资源与接收端发布副本
  app.js                 手机页面状态与操作
  audio-engine.js        采集、增益、变声和录音
  connection.js          WebSocket 配对与 WebRTC 连接
  voice-dsp.js           音效 DSP
  voice-worklet.js       AudioWorklet 处理器
  sender.css             手机端和接收端基础样式
  receiver.css           接收端样式
server/                  静态服务、配对信令、首次设置服务
scripts/                 Windows 启动、证书管理和检查工具
tests/                   Node 测试、浏览器回归与硬件诊断
docs/                    使用、部署和开发说明
.github/workflows/       GitHub Actions 自动检查
Start-PocketLink.cmd     一键启动
Stop-PocketLink.cmd      停止脚本管理的服务
```

`html/dist/` 是当前项目实际维护的静态源码目录，不是可随意删除的构建缓存。项目使用原生 ES Modules，无前端框架或打包步骤。

接收端只编辑 `client/index.html`、`client/receiver.js`，随后运行：

```sh
npm run build:static
```

它将接收端同步到 `html/dist/receiver/index.html` 和 `html/dist/receiver.js`，便于独立静态托管。Node 服务直接读取 `client/`。`npm run check` 会验证这两份副本与源码一致，避免静态托管发布旧版本。

## 格式与提交

```sh
npm run format
npm run format:check
npm run check
npm test
```

Prettier 统一 JavaScript、HTML、CSS、JSON、Markdown 和 YAML：2 空格缩进、JavaScript 单引号、分号、100 字符目标行宽。`.editorconfig` 和 `.gitattributes` 固定编码与换行；Windows `.cmd` 使用 CRLF，PowerShell 保留 4 空格缩进。

格式化排除生成的接收端副本，再通过 `build:static` 同步。不要手动编辑这些副本。HTML 模板字符串不做嵌入语言格式化，避免改变运行时生成内容。

依赖使用 `package-lock.json` 锁定版本。首次安装和 CI 使用 `npm ci`，只在有意变更依赖时运行 `npm install`。

不要提交 `.env`、证书与私钥、`.runtime/`、`.tools/`、`node_modules/` 或 `artifacts/`。`.env.example` 中只放示例占位符。运行状态可能包含本机停止接口的令牌。

## 自动化测试

### Node 测试

`npm test` 覆盖配对房间隔离、消息校验、来源限制、TURN 临时凭据、二维码以及变声音频频谱与切换平滑性。

证书集成测试依赖 Windows 和项目根目录的 `mkcert.exe`，缺少工具时会明确跳过。它在临时目录生成测试 CA，不安装系统信任，也不使用个人证书。GitHub 的 Linux CI 不执行该平台相关用例。

### 浏览器回归

```sh
npm run test:ui
```

依次执行：

- `receiver-output-ui.mjs`：模拟输出设备，检查系统麦克风路由、权限和偏好恢复。
- `pairing-ui.mjs`：合成麦克风、二维码配对、真实 WebRTC 传音及失败重试。
- `sender-ui.mjs`：手机页面、静音、增益、变声、录音、音轨释放及响应式布局。

测试自行启动临时本机服务，使用合成音源，不采集真实麦克风；截图和测试音频输出到忽略的 `artifacts/`。不要同时运行多份会写相同截图文件的测试。

没有 Chrome 时，可以安装 Playwright Chromium：

```sh
npx playwright install chromium
```

PowerShell 指定测试浏览器：

```powershell
$env:BROWSER_CHANNEL='chromium'
npm.cmd run test:ui
```

Linux/macOS：

```sh
BROWSER_CHANNEL=chromium npm run test:ui
```

GitHub Actions 在 Node.js 22/24 上运行格式、语法和 Node 测试，并单独使用 Chromium 运行浏览器回归。

### 手动与硬件检查

启动器检查需先启动本机 HTTPS 服务，验证真实证书信任、首次设置和二维码：

```powershell
$env:POCKETLINK_TEST_URL='https://localhost:8787'
npm.cmd run test:launcher
```

VB-CABLE 诊断需事先安装驱动，显式启用后才运行。它只向虚拟声卡发送测试音，并读取对应虚拟录音端点：

```powershell
$env:ENABLE_VIRTUAL_CABLE_TEST='1'
npm.cmd run test:cable
Remove-Item Env:ENABLE_VIRTUAL_CABLE_TEST
```

也可开启本机浏览器测试页：

```powershell
$env:ENABLE_BROWSER_TESTS='1'
npm.cmd start
# 打开 http://localhost:8787/__tests__/browser.html
# 停止服务后清除开关：
Remove-Item Env:ENABLE_BROWSER_TESTS
```

iPhone Safari 权限与证书安装、外网 TURN、USB 网络共享及 Windows 虚拟声卡仍需在真实设备上验证。Chromium 自动化不能代替这些检查。
