# PocketLink iPhone App（0.3.0 / Build 4）

SwiftUI 原生客户端，连接现有 Windows PocketLink 服务。最低 iOS 16。工程已经配置后台音频，目标是在开启麦克风后继续锁屏传音；**本次修复在 Windows 完成，尚未完成新版的 Xcode 编译和 iPhone 真机验收**。

## 本次更新与安装

新增原生 USB 直连：App 默认选择 USB，输入电脑 USB 配对码即可等待数据线连接。无需热点、Wi-Fi、局域网、IP 或手机根证书。麦克风采用 AVAudioEngine，经 Apple USB 通道发送 PCM，音效与变声控制复用同一通道；无线仍用 WebRTC。需要重新在 Mac 编译安装 Build 4，Windows 模拟协议和浏览器播放已验证，Swift 编译与真机尚未验证。参见 [USB 设置](../docs/usb.md)。

- 麦克风启停、音频会话激活和连接清理改为独立串行队列。释放配置锁后才启用 WebRTC 音频和音轨，避免配置锁与音频线程相互等待、卡住界面。
- 开启过程中点击断开或遭遇电话中断，会取消尚未完成的开启操作；旧连接的回调不会更新新连接状态。
- 切后台或锁屏不再主动关闭连接。返回前台先检查原连接；确实失效才重新配对，检查时显示“检查连接…”。
- 新增“保持后台开启”：用户明确开启并允许麦克风权限后复用当前连接的音频会话（USB 为 AVAudioEngine，无线为 WebRTC），持续采集但关闭人声发送，不保存录音。iOS 会显示橙色麦克风指示。开关默认关闭，每次重新配对需要手动开启；电话或音频设备中断后停止，需要用户重新开启。
- App 增加动态变声选择：原声、低沉、卡通、机器人、磁性、清亮、巨人、外星人。由电脑接收页处理当前选中的一个麦克风，App 触发的音效保持原音；切回原声释放变声处理器。
- 电脑接收页“设置 → 添加自定义音效”可随时上传 MP3、WAV、M4A。已连接的 App 自动更新列表，也可以点音效栏的刷新按钮，无需重新编译 App。

将新版源码包交给朋友，重新编译 **iPhone 真机 IPA**，再在 Windows 用原先的账号和 Bundle Identifier 重新签名、覆盖安装。本次需重启 Windows 服务并刷新接收页，再安装新版 IPA；以后只新增音效无需重编译。无需更换音频驱动或 HTTPS 根证书。

## 交给有 Mac 的朋友

需要完整 Xcode（建议 16 或更新，且支持手机当前的 iOS 版本），首次构建需联网下载 WebRTC。无需 CocoaPods、Homebrew 或 XcodeGen。

1. 从 GitHub 获取最新 `main` 分支，将 **整个 `ios` 文件夹** 复制到 Mac。
2. 双击 `PocketLink.xcodeproj`，等待 **Package Dependencies** 下载完成。WebRTC 固定为 `140.0.0`。
3. 在 **Xcode → Settings → Accounts** 登录用于签名的 Apple Account。
4. 选择左侧工程 → **TARGETS → PocketLink → Signing & Capabilities**，勾选 **Automatically manage signing**，选择自己的 **Team**。将 **Bundle Identifier** 改成唯一名称，例如 `com.yourname.pocketlink`。真机运行单元测试时，`PocketLinkTests` 也选择同一 Team 并修改其标识。
5. 数据线连接 iPhone 和 Mac，在手机点 **Trust**。根据提示开启 **Settings → Privacy & Security → Developer Mode** 并重启手机；该选项可能要与 Xcode 配对后才出现。[Apple 开发者模式说明](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
6. Xcode 顶部选择 **PocketLink** scheme 和实际 iPhone，点击 **▶ Run**。如提示开发者未受信任，按手机提示进入 **Settings → General → VPN & Device Management** 信任对应开发者。
7. 安装后可断开 Mac，用 App 连接 Windows。测试后台功能时，从 Xcode 停止调试，再从手机桌面打开 App，避免调试器影响后台行为。

免费 Apple Account 可通过 Personal Team 做个人真机测试；免费签名通常需要 7 天后重新构建安装。长期分发给他人可使用付费开发者计划的 TestFlight 等方式。单独发送一个未签名 IPA 无法直接安装。[Apple 账号与签名限制](https://developer.apple.com/support/compare-memberships/)

## 第一次连接 Windows

USB：插线、解锁并信任电脑，在 Windows 运行 `Start-PocketLink.cmd`，电脑点击「连接手机 → USB 有线」创建配对码；App 选择 USB 有线并输入配对码后点连接。无需热点、扫码或手机证书。以下 1–3 步仅用于无线连接，输出和麦克风控制步骤适用于两种模式。参见 [USB 设置与验收](../docs/usb.md)。

1. Windows 使用本次更新后的项目，运行 `Start-PocketLink.cmd`，刷新电脑接收页，创建配对码。
2. iPhone 与 Windows 接入同一可互通网络。从电脑接收页的 **首次使用 iPhone？** 打开设置页，安装该电脑的公共根证书：
   - **Settings → Profile Downloaded → Install**。
   - **Settings → General → About → Certificate Trust Settings** → 开启该根证书的信任。
3. App 点击 **扫码连接**，扫描电脑的配对二维码（不是证书设置二维码）。允许 **Camera** 和 **Local Network** 权限。也可输入电脑显示的 `https://电脑IP:8787` 和 8 位配对码。App 只记住地址，下一次启动需要重新配对。
4. 配对后直接点音效；需要手机传人声时先在电脑选择 **手机** 并开启输入，再在 App 点 **开启麦克风** 并允许 **Microphone**。
5. 电脑接收页选择 **设置 → 系统麦克风**。会议/游戏里选择 **PocketLink 麦克风 / CABLE Output**。在电脑主面板选择电脑麦克风并开启即可；选择 **手机** 才会接入手机人声。

**Safari 的 “This Connection Is Not Private → Continue” 不等于系统信任证书。App 不跳过 TLS 校验。** 换 IP 后重跑 Windows 启动脚本，再扫码；同一个根 CA 通常无需重装证书。不要传输 `rootCA-key.pem`、网站私钥或整个 `certs` 目录给朋友。

如果拒绝了权限：新版 iOS 可在 **Settings → Apps → PocketLink** 查看应用权限；也可在 **Settings → Privacy & Security → Local Network / Microphone / Camera** 调整。

## 本版包含什么

| 功能            | 行为                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| 扫码 / 配对码   | 兼容现有 8 位配对码，支持局域网；设置里可启用已配置好的 TURN 中继                 |
| 手机麦克风      | USB：AVAudioEngine / PCM；无线：WebRTC / Opus；用户开启后采集                     |
| 锁屏传音        | 配置 `playAndRecord`、`voiceChat` 和后台 `audio`；需通过下方真机测试确认          |
| 音效            | 从电脑取得列表，手机发送音效 ID，电脑直接播放并混入虚拟麦克风；只支持已导入的文件 |
| 仅音效模式      | 后台保持关闭时不申请麦克风权限；开启后台保持后占用麦克风但不发送人声              |
| 手机断开        | 已开启的电脑麦克风继续运行；原生 App 触发的音效在电脑继续播完                     |
| 电话 / 拔掉耳机 | 停止手机麦克风并提示，返回后由用户重新开启；不自动恢复录音                        |

未开启“保持后台开启”的仅音效模式不主动断开，但系统挂起 App 后网络连接仍可能失效：电脑人声和已经开始的音效独立运行。返回前台时先检查连接，失效后重连；若配对码已过期或电脑刷新了会话，需要重新扫码。开启手机麦克风时依靠真实的后台音频采集保活，电话打断、系统结束进程、断网或手动划掉 App 仍会中断。

本版未移植网页的 RNNoise 开关和本地录音/导出；手机端 USB 使用 AVAudioEngine 语音处理，无线使用 WebRTC 语音处理，变声放在电脑执行。回声消除只对设备能获取到的播放参考有效，不能承诺消除电脑扬声器的声音。仍使用 Windows 浏览器接收和 VB-CABLE；这不是 iPhone 的 USB Audio 硬件模拟。USB 直连使用单独的回环监听与 Apple USB 通道，详见 USB 指南。

## Mac 编译检查

在项目根目录执行：

```sh
bash ios/check.sh
```

脚本验证工程 plist、解析依赖、选择已安装的 iPhone 模拟器并构建运行 XCTest，不需要签名。测试覆盖扫码地址、手动配对码、IPv6、无效/不安全地址，以及慢速音频激活不阻塞主线程、激活中取消、重复开启的激活平衡、激活失败后的清理与重试。新增 XCTest 在 Windows 尚未执行。也可以直接在 Xcode **Product → Test**。仓库提供 `iPhone App` GitHub Actions，iOS 源码推送后自动运行，构建结果以 GitHub Actions 页面为准。

如果只复制了 iOS 源码包，在包含 `PocketLink.xcodeproj` 的文件夹中运行 `bash check.sh`。

模拟器不能替代真机麦克风、扫码、锁屏测试。Windows 侧可执行 `node tests/native-control-ui.mjs` 验证数据通道、音效混音和断线保持；该测试不编译 Swift。

## 真机验收

1. 手机麦克风和后台保持均关闭，配对并播放音效，会议软件能收到；手机不出现录音指示。
2. 电脑选择并开启已有麦克风，同时播放音效，其他软件能同时收到两者。
3. 开启手机麦克风，先确认输入有声，再锁屏 1、5、15 分钟并持续讲话，检查电脑和会议软件的输入。记录 iPhone 型号、iOS 版本、是否接电和所在网络。
4. 只播音效时短暂切后台，确认不会立刻主动断开；锁屏 1、5、15 分钟，允许系统暂停连接。电脑人声不间断、音效能播完；回 App 时无线检查原连接、失效才重连；USB 断线需重新配对。灵动岛和 Background App Refresh 都不能保证 WebRTC 常驻。
5. 测试拒绝录音权限、拔耳机、电话中断、Wi-Fi 断开/恢复、电脑关闭接收页、配对码过期，确认有明确提示、无意外录音，电脑麦克风不被手机生命周期关闭。
6. 连续开关麦克风，并在“正在切换…”期间点断开，确认界面仍可操作，稍后不会重新开启录音。手动关闭手机麦克风或断开连接，检查 iOS 录音指示消失。关闭电脑接收页应停止电脑采集。

7. 开启“保持后台开启”、关闭人声发送：手机旁讲话，电脑输出应无手机人声；锁屏 1、5、15、30 分钟，检查连接是否持续，解锁后直接点音效。打开人声发送再关闭，应不重建采集；关闭两项后橙色指示消失。需在真机确认 WebRTC 禁用音轨时采集和后台运行确实持续。
8. 手机和电脑同时讲话，切换电脑输入，每次只听到所选的一路；切换 App 变声只处理该路，App 音效保持原音；电脑麦克风插拔后列表实时更新，拔出当前设备不能自动打开其他麦克风。
9. 保持配对，在电脑上传新音效，App 无需重连即出现；在 App 点击并确认会议软件收到声音。

后台保持不会提供“永久在线”的系统保证：网络变化、电话抢占、系统终止、手动划掉 App 都可能中断。它复用一个采集会话、不建立额外录音器、不写音频文件、不用轮询或播放静音文件；实际 CPU、网络、耗电和锁屏持续性尚未真机测量，不能声称绝对最低占用。变声只在电脑上进行，默认原声不运行变声 Worklet。

## 协议与依赖

无线原生端使用现有 `/api/config`、`/signal` 和 `pocketlink-v1` 信令；通过有序 WebRTC DataChannel `pocketlink-control-v1` 发送 `{type:"play-sound",id}` / `{type:"stop-sound"}`。电脑返回 `catalog`、`sound-state`、`sound-error`。音效 ID 必须属于电脑目录，手机不能指定远程音频地址；上传限制单个 10 MB、总数最多 50 个；播放时另有 20 MB 的防御限制。上传入口仅允许服务所在电脑持有本次服务令牌的请求，并以内容哈希存储文件，追加目录而不覆盖旧音效。同内容文件重复上传复用已有条目。

无线麦克风音轨在配对时创建但禁用；`RTCAudioSession.useManualAudio` 避免只播音效时初始化录音。开启人声发送或后台保持后，使用 WebRTC 音频会话代理控制系统音频。`set-voice` / `voice-state` 同步变声预设和选中状态，`refresh-catalog` 手动刷新音效目录，上传成功后通过信令事件通知接收端重新推送目录。

WebRTC 通过 [stasel/WebRTC Swift Package](https://github.com/stasel/WebRTC/tree/140.0.0) 获取预编译框架，框架及上游组件遵循各自许可证。发布 App 前应复核该二进制版本、依赖许可证、隐私声明和真机验收结果。工程中没有开发者证书、Team ID 或个人签名私钥。

关于后台限制：参见 [Apple 后台执行模式](https://developer.apple.com/documentation/xcode/configuring-background-execution-modes) 和 [Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)。灵动岛提供状态展示，不为主 App 提供无限运行时间；本版没有加入灵动岛扩展。
