import AVFAudio
import Combine
import Foundation
import UIKit
import WebRTC

final class AppModel: ObservableObject {
    @Published var server = UserDefaults.standard.string(forKey: "server") ?? ""
    @Published var code = ""
    @Published var connectionMode = "usb"
    @Published private(set) var connected = false
    @Published private(set) var busy = false
    @Published private(set) var microphone = false
    @Published private(set) var keepAlive = false
    @Published private(set) var voices: [SoundPreset] = []
    @Published private(set) var voice = "original"
    @Published private(set) var changingVoice = false
    @Published private(set) var requestingMicrophone = false
    @Published private(set) var checkingConnection = false
    @Published private(set) var controlReady = false
    @Published private(set) var sounds: [SoundPreset] = []
    @Published private(set) var playingID: String?
    @Published var message = ""
    private let rtc = RTCClient()
    private let usb = USBClient()
    private var usingUSB = false
    private let session: URLSession
    private var configTask: URLSessionDataTask?
    private var socket: URLSessionWebSocketTask?
    private var timeout: DispatchWorkItem?
    private var healthTimeout: DispatchWorkItem?
    private var healthRevision = 0
    private var rtcConnected = false
    private var audioOperation = 0
    private var voiceTimeout: DispatchWorkItem?
    private var generation = 0
    private var endpoint: PairingEndpoint?
    private var iceServers: [RTCIceServer] = []
    private var background = false
    private var resumeOnForeground = false
    private var interruptionToken: NSObjectProtocol?
    private var routeToken: NSObjectProtocol?

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
        usb.onConnected = { [weak self] in
            guard let self = self, self.usingUSB else { return }
            self.timeout?.cancel()
            self.connected = true
            self.busy = false
            self.controlReady = true
            self.message = "USB 已连接 · 无需热点或局域网"
        }
        usb.onControl = { [weak self] in self?.handleControl($0) }
        usb.onError = { [weak self] in self?.fail($0) }
        rtc.onSignal = { [weak self] in self?.send($0) }
        rtc.onError = { [weak self] in self?.fail($0, allowRecovery: true) }
        rtc.onState = { [weak self] state in
            guard let self = self else { return }
            if state == "connected" {
                self.rtcConnected = true
                self.timeout?.cancel()
                self.connected = true
                self.busy = false
                self.checkingConnection = self.healthTimeout != nil
                self.message = ""
            } else {
                self.rtcConnected = false
                self.checkingConnection = true
                self.message = "网络中断，正在恢复…"
                self.armTimeout(seconds: 12, allowRecovery: true)
            }
        }
        rtc.onControlReady = { [weak self] in self?.controlReady = true }
        rtc.onControl = { [weak self] in self?.handleControl($0) }
        interruptionToken = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  type == AVAudioSession.InterruptionType.began.rawValue else { return }
            self?.interruptMicrophone("音频被电话或其他 App 中断，结束后请重新开启麦克风或后台保持。")
        }
        routeToken = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
            self?.interruptMicrophone("音频设备已断开，请确认设备后重新开启麦克风或后台保持。")
        }
    }

    deinit {
        if let interruptionToken = interruptionToken { NotificationCenter.default.removeObserver(interruptionToken) }
        if let routeToken = routeToken { NotificationCenter.default.removeObserver(routeToken) }
        session.invalidateAndCancel()
    }

    func connect() {
        if connectionMode == "usb" { connectUSB(); return }
        do { connect(try PairingEndpoint(server: server, code: code, mode: connectionMode)) }
        catch { message = error.localizedDescription }
    }

    func scan(_ text: String) {
        do {
            let endpoint = try PairingEndpoint(qr: text)
            server = endpoint.base.absoluteString
            code = endpoint.code
            connectionMode = endpoint.mode
            if endpoint.mode == "usb" { connectUSB(); return }
            connect(endpoint)
        } catch { message = error.localizedDescription }
    }

    private func connectUSB() {
        let cleaned = code.filter { !$0.isWhitespace }
        guard cleaned.range(of: "^[0-9]{8}$", options: .regularExpression) != nil else {
            message = "请输入电脑 USB 接收页的 8 位配对码。"; return
        }
        disconnect()
        usingUSB = true
        busy = true
        message = "等待 USB 电脑连接，请保持 App 在前台。无需开启热点。"
        let token = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.generation == token else { return }
            self.fail(PocketError.message("USB 配对超时。请检查数据线、Trust 提示、电脑 USB 接收页和配对码。"))
        }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: work)
        usb.start(code: cleaned)
    }

    @discardableResult private func sendControl(_ value: [String: Any]) -> Bool {
        if usingUSB { return connected && usb.sendControl(value) }
        return rtc.sendControl(value)
    }

    private func setMicrophone(_ enabled: Bool, keepAlive: Bool = false, completion: @escaping (Result<Void, Error>) -> Void) {
        if usingUSB { usb.setMicrophone(enabled, keepAlive: keepAlive, completion: completion) }
        else { rtc.setMicrophone(enabled, keepAlive: keepAlive, completion: completion) }
    }

    private func connect(_ endpoint: PairingEndpoint) {
        disconnect()
        self.endpoint = endpoint
        UserDefaults.standard.set(endpoint.base.absoluteString, forKey: "server")
        busy = true
        message = "正在连接…"
        let token = generation
        armTimeout(seconds: 30)
        configTask = session.dataTask(with: endpoint.base.appendingPathComponent("api/config")) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.generation == token else { return }
                do {
                    if let error = error { throw error }
                    guard (response as? HTTPURLResponse)?.statusCode == 200,
                          let data = data, data.count < 65536,
                          let config = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          config["protocol"] as? String == "pocketlink-v1" else {
                        throw PocketError.message("此地址不是可用的 PocketLink 服务。")
                    }
                    if endpoint.mode == "server" && config["relayAvailable"] as? Bool != true {
                        throw PocketError.message("电脑服务未配置 TURN 中继，请使用同一局域网。")
                    }
                    self.iceServers = (config["iceServers"] as? [[String: Any]] ?? []).compactMap { item in
                        let urls = item["urls"] as? [String] ?? (item["urls"] as? String).map { [$0] } ?? []
                        guard !urls.isEmpty else { return nil }
                        return RTCIceServer(urlStrings: urls, username: item["username"] as? String, credential: item["credential"] as? String)
                    }
                    let socket = self.session.webSocketTask(with: endpoint.signaling)
                    socket.maximumMessageSize = 65536
                    self.socket = socket
                    socket.resume()
                    self.receive(socket, token: token)
                    self.send(["type": "join", "code": endpoint.code, "mode": endpoint.mode])
                } catch { self.fail(error) }
            }
        }
        configTask?.resume()
    }

    private func receive(_ socket: URLSessionWebSocketTask, token: Int) {
        socket.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, self.generation == token else { return }
                if case .failure(let error) = result {
                    self.fail(error, allowRecovery: true)
                    return
                }
                do {
                    let data: Data
                    switch try result.get() {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: throw PocketError.message("无法读取配对消息。")
                    }
                    guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        throw PocketError.message("配对消息格式错误。")
                    }
                    try self.handle(message)
                    if self.generation == token { self.receive(socket, token: token) }
                } catch { self.fail(error) }
            }
        }
    }

    private func handle(_ value: [String: Any]) throws {
        switch value["type"] as? String {
        case "joined":
            message = "正在建立音频连接…"
            let relay = endpoint?.mode == "server"
            try rtc.start(iceServers: relay ? iceServers : [], relay: relay)
        case "signal": rtc.receive(value)
        case "error": throw PocketError.message(value["message"] as? String ?? "配对失败。")
        case "peer-left": throw PocketError.message("电脑接收页已关闭，请重新配对。")
        default: break
        }
    }

    private func send(_ message: [String: Any]) {
        guard let socket = socket, let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        let token = generation
        socket.send(.string(text)) { [weak self] error in
            DispatchQueue.main.async {
                guard let self = self, self.generation == token, let error = error else { return }
                self.fail(error, allowRecovery: true)
            }
        }
    }

    private func armTimeout(seconds: Double, allowRecovery: Bool = false) {
        timeout?.cancel()
        let token = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.generation == token else { return }
            self.fail(PocketError.message("连接超时，请检查电脑服务、防火墙和手机的 Local Network 权限。"), allowRecovery: allowRecovery)
        }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func toggleMicrophone() {
        configureAudio(microphone: !microphone, keepAlive: keepAlive)
    }

    func toggleKeepAlive() {
        configureAudio(microphone: microphone, keepAlive: !keepAlive)
    }

    private func configureAudio(microphone desiredMicrophone: Bool, keepAlive desiredKeepAlive: Bool) {
        guard connected, !requestingMicrophone else { return }
        audioOperation += 1
        let operation = audioOperation
        let token = generation
        requestingMicrophone = true
        if microphone || keepAlive || (!desiredMicrophone && !desiredKeepAlive) {
            changeMicrophone(desiredMicrophone, keepAlive: desiredKeepAlive, token: token, operation: operation)
            return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self = self, self.generation == token, self.audioOperation == operation else { return }
                guard self.connected, !self.background else {
                    self.requestingMicrophone = false
                    return
                }
                guard allowed else {
                    self.requestingMicrophone = false
                    self.message = "请在 Settings → PocketLink → Microphone 允许录音。"; return
                }
                self.changeMicrophone(desiredMicrophone, keepAlive: desiredKeepAlive, token: token, operation: operation)
            }
        }
    }

    private func changeMicrophone(_ enabled: Bool, keepAlive: Bool, token: Int, operation: Int) {
        setMicrophone(enabled, keepAlive: keepAlive) { [weak self] result in
            guard let self = self, self.generation == token, self.audioOperation == operation else { return }
            self.requestingMicrophone = false
            switch result {
            case .success:
                self.microphone = enabled
                self.keepAlive = keepAlive
                self.message = ""
            case .failure(let error):
                self.microphone = false
                self.keepAlive = false
                self.message = "无法切换麦克风：" + error.localizedDescription
            }
        }
    }

    private func interruptMicrophone(_ reason: String) {
        guard microphone || keepAlive || requestingMicrophone else { return }
        audioOperation += 1
        requestingMicrophone = false
        setMicrophone(false) { _ in }
        microphone = false
        keepAlive = false
        message = reason
    }

    func play(_ sound: SoundPreset) {
        let command: [String: Any] = playingID == sound.id ? ["type": "stop-sound"] : ["type": "play-sound", "id": sound.id]
        if !sendControl(command) { message = "音效控制尚未连接，请更新并刷新电脑接收页。" }
    }
    func stopSound() { _ = sendControl(["type": "stop-sound"]) }
    func refreshSounds() { _ = sendControl(["type": "refresh-catalog"]) }

    func selectVoice(_ id: String) {
        guard !changingVoice, voices.contains(where: { $0.id == id }) else { return }
        guard sendControl(["type": "set-voice", "id": id]) else {
            message = "变声控制尚未连接。"; return
        }
        changingVoice = true
        voiceTimeout?.cancel()
        let token = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.generation == token else { return }
            self.changingVoice = false
            self.message = "变声切换未收到确认，请检查电脑接收页。"
        }
        voiceTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }
    private func handleControl(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "voice-state":
            guard let list = message["presets"], let data = try? JSONSerialization.data(withJSONObject: list),
                  let values = try? JSONDecoder().decode([SoundPreset].self, from: data),
                  let selected = message["selected"] as? String else { return }
            var ids = Set<String>()
            voices = Array(values.filter { ids.insert($0.id).inserted }.prefix(32))
            if voices.contains(where: { $0.id == selected }) { voice = selected }
            voiceTimeout?.cancel()
            changingVoice = false
        case "voice-error":
            voiceTimeout?.cancel()
            changingVoice = false
            self.message = message["message"] as? String ?? "变声切换失败。"
        case "catalog":
            guard let list = message["sounds"], let data = try? JSONSerialization.data(withJSONObject: list),
                  let values = try? JSONDecoder().decode([SoundPreset].self, from: data) else { return }
            var ids = Set<String>()
            sounds = Array(values.filter { ids.insert($0.id).inserted }.prefix(50))
            if sounds.isEmpty { self.message = "电脑尚未导入音效。" }
            else if self.message == "电脑尚未导入音效。" { self.message = "" }
        case "sound-state": playingID = message["id"] as? String
        case "sound-error": self.message = message["message"] as? String ?? "音效播放失败。"
        default: break
        }
    }

    func enteredBackground() {
        background = true
        // Keep the same peer/socket. Active recording provides background audio;
        // without it iOS may suspend us, but entering background is not a disconnect.
    }
    func enteredForeground() {
        background = false
        if resumeOnForeground, let endpoint = endpoint {
            resumeOnForeground = false
            connect(endpoint)
        } else if connected, let socket = socket {
            // Only reconnect after a real failure, never simply because the scene changed.
            checkingConnection = true
            healthTimeout?.cancel()
            healthRevision += 1
            let healthToken = healthRevision
            let token = generation
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.generation == token, self.healthRevision == healthToken else { return }
                self.fail(PocketError.message("后台连接已失效，正在重新连接。"), allowRecovery: true)
            }
            healthTimeout = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
            socket.sendPing { [weak self] error in
                DispatchQueue.main.async {
                    guard let self = self, self.generation == token, self.healthRevision == healthToken else { return }
                    self.healthTimeout?.cancel()
                    self.healthTimeout = nil
                    if let error = error { self.fail(error, allowRecovery: true) }
                    else { self.checkingConnection = !self.rtcConnected }
                }
            }
        }
    }

    func disconnect() {
        generation += 1
        audioOperation += 1
        voiceTimeout?.cancel()
        timeout?.cancel()
        healthTimeout?.cancel()
        healthTimeout = nil
        rtcConnected = false
        configTask?.cancel()
        configTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        usb.close()
        usingUSB = false
        rtc.close()
        endpoint = nil
        resumeOnForeground = false
        connected = false
        busy = false
        microphone = false
        keepAlive = false
        voices = []
        voice = "original"
        changingVoice = false
        requestingMicrophone = false
        checkingConnection = false
        controlReady = false
        sounds = []
        playingID = nil
        message = ""
    }

    private func fail(_ error: Error, allowRecovery: Bool = false) {
        let saved = endpoint
        let recover = allowRecovery && (background || checkingConnection) && saved != nil
        disconnect()
        if recover, let saved = saved {
            if background {
                endpoint = saved
                resumeOnForeground = true
            } else {
                connect(saved)
                return
            }
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && [-1200, -1201, -1202, -1203, -1204].contains(nsError.code) {
            message = "证书未受信任。请从电脑的“首次使用 iPhone？”页面安装根证书，并在 Settings → General → About → Certificate Trust Settings 开启信任。"
        } else { message = error.localizedDescription }
    }
}
