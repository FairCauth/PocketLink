# PocketLink

把 iPhone 变成电脑麦克风。扫码或输入配对码，即可传输声音、实时变声和录音。

手机与电脑都通过网页操作，界面只保留连接和麦克风控制。Windows 安装 VB-CABLE 后，可以在会议、游戏和录音软件里使用手机的声音。

> 当前版本：手机网页 + 电脑网页接收端 + Node.js 信令服务。尚未实现原生 iPhone App、Windows 桌面客户端或插上 USB 即用的原生音频传输。

## 功能

- **扫码直连 / 配对码**：8 位配对码，等待有效期 10 分钟，一个接收端连接一台手机。
- **麦克风控制**：实时波形、音量、静音、浏览器降噪与回声消除。
- **实时变声**：原声、低沉、卡通、机器人，在手机本地处理，同步用于传输和录音。
- **本地录音**：回听、下载；录音保存在页面内存，不上传存储。
- **系统麦克风**：电脑接收端一键切换「系统麦克风」或「电脑试听」。
- **Windows 启动脚本**：准备依赖、配置本地 HTTPS、检测 IP 变化、启动和停止服务。

## 快速开始（Windows + iPhone）

### 1. 启动电脑服务

下载并解压本仓库，双击 **`Start-PocketLink.cmd`**。

首次运行需要联网，脚本会准备 Node.js 22+、项目依赖和 mkcert，生成本机证书，并打开电脑接收页：

```text
https://localhost:8787/receiver
```

手机和电脑须处于可互通的网络。首次出现防火墙提示时，允许 Node.js 在当前可信网络通信。

### 2. 配置手机并连接

第一次使用，在电脑接收端点击 **「首次使用 iPhone？」**，用 Safari 打开设置页，下载并安装公共根证书：

1. **Settings → Profile Downloaded → Install**。
2. **Settings → General → About → Certificate Trust Settings**，开启对应根证书的完全信任。
3. 电脑点击 **「创建配对码」**，手机扫码打开网页并允许麦克风；也可手动打开网址输入配对码。

同一根证书只需信任一次；IP 改变后重新运行启动脚本即可。无需通过邮件传证书，也不用手动设置 `TLS_CERT`。[详细设置与常见问题](docs/usage.md)

### 3. 在其他软件里使用

1. 安装 [VB-CABLE](https://vb-audio.com/Cable/)，按安装器要求重启电脑。
2. 电脑 PocketLink 接收端打开 **设置 → 系统麦克风**。
3. 在会议、游戏或录音软件中选择 **CABLE Output** 作为输入设备。

可以在 Windows 声音设置中将这个录音设备重命名为 **PocketLink 麦克风**。保留播放设备 `CABLE Input` 的原名，供接收端自动识别。接收网页需保持打开并播放。[设备设置说明](docs/usage.md#让会议软件使用手机麦克风)

停止服务：双击 **`Stop-PocketLink.cmd`**，或在启动窗口按 **Ctrl+C**。

## 连接方式

| 方式              | 需要准备什么                         | 当前状态                         |
| ----------------- | ------------------------------------ | -------------------------------- |
| 局域网            | 手机和电脑网络互通、手机可访问 HTTPS | WebRTC 点对点音频                |
| 服务器            | 公网 HTTPS 服务与 TURN 服务          | 支持配置，需自行部署联调         |
| 有线              | 先通过 USB 个人热点等方式建立网络    | 复用 WebRTC；不强制绑定 USB 网卡 |
| 原生 USB 即插即用 | iPhone App 与电脑 USB 接收程序       | 尚未实现                         |

音频路径：

```text
iPhone Safari → 本地音效处理 → WebRTC → 电脑接收网页
                                            ↓
                                       CABLE Input
                                            ↓
                               PocketLink 麦克风 / CABLE Output
                                            ↓
                                      会议、游戏、录音软件
```

## 开发

需要 Node.js **22 或更高版本**：

```sh
npm ci
npm run dev
```

手动启动默认使用 HTTP；电脑可访问 `http://localhost:8787/receiver`。iPhone 麦克风需要 HTTPS，使用 Windows 启动脚本，或按[部署文档](docs/deployment.md)配置。

```sh
npm run format       # 统一格式，并同步接收端静态副本
npm run format:check # 检查代码格式
npm run check        # 检查 JavaScript 语法与静态副本一致性
npm test             # 服务端、证书流程和变声 DSP 测试
npm run test:ui      # 浏览器回归（默认使用已安装的 Chrome）
```

PowerShell 如果限制运行 `npm.ps1`，把命令中的 `npm` 替换成 `npm.cmd`。[开发说明、目录结构与测试条件](docs/development.md)

## 使用边界

- 当前仅支持 **手机 → 电脑**，不包含反向音频或自研虚拟声卡驱动。
- iPhone 锁屏、切换应用或电话打断可能暂停网页麦克风；使用时保持网页在前台。
- 录音在刷新或关闭页面后丢失，请及时下载；单段最多 30 分钟或约 50 MB。
- 浏览器设备选择、音效与音频处理能力依赖系统和浏览器。Windows 接收端建议使用 Chrome / Edge。
- Node 服务处理配对信令，不保存录音；服务器模式经 TURN 转发加密音频。
- 公网部署目前仍是无账号原型，长期开放前需要补充身份认证、配额和监控。

## 文档

- [使用指南：启动、证书、网络、虚拟麦克风与录音](docs/usage.md)
- [部署指南：HTTPS、环境变量与 TURN](docs/deployment.md)
- [开发指南：代码约定、项目结构与测试](docs/development.md)

mkcert 与 VB-CABLE 是独立第三方项目，其许可与安装要求以各自官方说明为准。本仓库不包含其二进制文件或驱动安装包。
