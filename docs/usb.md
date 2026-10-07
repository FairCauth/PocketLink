# USB 有线直连（Windows + 原生 iOS App）

USB 模式通过 Apple 的 usbmux 通道传输麦克风音频与控制消息，**不需要个人热点、Wi-Fi、同一局域网、蜂窝数据或手机 HTTPS 根证书**。USB 模式不使用 WebRTC，也不回退到无线同步或热点网卡。电脑接收页、混音、变声和 VB-CABLE 输出保持可用。

本次提供 iOS **0.4.0 / Build 5** 源码，需要重新在 Mac 编译签名并覆盖安装。旧 App 的“USB”实际使用热点网络，无法连接新版 USB 接收页。当前已通过 Windows 协议模拟和真实浏览器音频测试；新版 Swift 编译、iPhone USB 传音、锁屏和延迟尚未真机验收。

## 使用步骤

1. Windows 安装 Apple Devices，使用支持数据传输的数据线连接 iPhone，解锁并点“信任此电脑”。已信任无需重复操作。
2. 双击 **Start-PocketLink.cmd**。首次缺少 Node.js、依赖、Apple Devices 或 VB-CABLE 时仍需联网准备；组件齐全后 USB 连接本身可离线使用。统一入口会准备电脑 HTTPS 并支持可选的无线连接；USB 传输仍只使用数据线，手机无需安装证书。
3. 电脑浏览器打开 `https://localhost:8787/receiver`，点击 **连接手机 → USB 有线 → 创建 USB 配对码**。同一服务只允许一个 USB 接收页，等待配对有效期 10 分钟。
4. 新版 iOS App 选择 **USB 有线**，输入电脑显示的 8 位配对码，再点 **连接**。无需填写 IP 或扫描网页二维码。首次配对保持 App 在前台；App 等待超过 2 分钟会提示重试。
5. 配对后，在 App 或电脑输入列表选择 **手机（USB 有线）**，再在 App 点 **开启麦克风** 并允许录音。也可只使用音效控制，不启动手机录音。需要系统输入时，电脑设置选择 **系统麦克风**，会议/游戏选择 **PocketLink 麦克风 / CABLE Output**。
6. 停止程序：在启动窗口按 **Ctrl+C**。再次双击启动会复用已运行的同一服务，不需要另外启动 USB 服务。

可用 `Start-PocketLink.cmd -Check` 只读检查组件与证书，用 `-Port 18787` 指定工作台端口。无需额外下载 iproxy 或 libimobiledevice 可执行文件。

## 确认真正经过数据线

准备组件后，关闭手机的个人热点、Wi-Fi、蜂窝数据，以及电脑 Wi-Fi/以太网，然后重新配对。确认手机讲话、音效、变声能在会议软件收到。拔掉数据线后，手机采集应停止，电脑显示 USB 断开；已有电脑麦克风继续输出，已开始的音效可继续播完。重新插线、重新配对后，麦克风由用户主动开启。

USB 连接不会自动启用麦克风或后台保持。开启麦克风或“保持后台开启”会进行真实采集并显示系统录音指示；后台保持关闭人声发送，不写录音文件。电话、耳机拔出、进程被结束或 iOS 挂起仍可能中断。后台持续性必须通过真机测试，不能保证永久在线。

## 常见情况

- **Apple USB 服务不可用**：安装/修复 Apple Devices，确认 Apple Mobile Device Service 运行；本机桥接访问 `127.0.0.1:27015`。无需开启个人热点。
- **未检测到 USB iPhone**：解锁、确认 Trust 提示、换数据线或 USB 口。系统只认出充电不代表支持数据通信；无线同步设备不会被接受。
- **检测到设备但一直等待 App**：确认安装的是 Build 4 或更新的 App，选择 USB、输入当前配对码、点连接并保持前台。配对码错误不会开启录音。
- **其他 USB 接收页已打开**：关闭旧页后重试。同一服务只连接一个接收页，避免多个窗口争用手机。
- **USB 显示连接但其他软件无声**：先在电脑选择手机输入并开启，再点 App 开启麦克风，电脑接收页确认有音量，再检查输出设备、播放按钮、音量和 VB-CABLE。

## 实现与验证

`server/usbmux.mjs` 直接使用 Apple 服务的 plist 协议（ListDevices/Connect），只筛选 `ConnectionType=USB`。App 的 Network.framework 监听设备回环 `127.0.0.1:23456`，通过配对码握手。Windows 的 `/usb` WebSocket 仅接受本机、同源浏览器；统一启动器同时支持 HTTPS 工作台与无线连接，但 USB 端点仍拒绝所有非本机浏览器请求。

协议为 `pocketlink-usb-v1`：4 字节大端长度，随后 1 字节类型。类型 1 为 UTF-8 JSON；类型 2 为 4 字节小端采样率及单声道 Int16 小端 PCM。App 使用 AVAudioEngine 的语音处理输入，按设备实际采样率发送；浏览器 AudioWorklet 重采样并接入现有混音。音效、变声控制也经过 USB，音效文件由电脑本地播放。发送积压和播放缓冲有上限，断线不自动重启录音。

自动化：`npm test`、`npm run test:usb`；iOS 在 Mac 运行 `bash ios/check.sh`。本机已读取到真实 Apple USB 服务，但当前没有数据线设备。模拟测试覆盖设备筛选、端口字节序、分包/合包、拒绝错误握手、取消连接、音频与控制、断线、同源保护；浏览器测试禁止 WebRTC 并验证真实 PCM 播放与变声。不能据此声称已通过 iPhone 真机测试。

协议参考：[libusbmuxd 项目](https://github.com/libimobiledevice/libusbmuxd)与[连接协议实现](https://github.com/libimobiledevice/libusbmuxd/blob/master/src/libusbmuxd.c)。
