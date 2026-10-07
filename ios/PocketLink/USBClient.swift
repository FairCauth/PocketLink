import AVFAudio
import Foundation
import Network

// All transport and audio lifecycle operations run on one queue. Only callbacks
// enter main. The listener binds loopback: Wi-Fi/LAN cannot reach this service.
final class USBClient {
    var onConnected: (() -> Void)?
    var onControl: (([String: Any]) -> Void)?
    var onError: ((Error) -> Void)?
    private let queue = AudioLifecycle.queue
    private var revision = 0
    private let revisionLock = NSLock()
    private var listener: NWListener?
    private var connection: NWConnection?
    private var heartbeat: DispatchSourceTimer?
    private var engine: AVAudioEngine?
    private var audioActive = false
    private var tapInstalled = false
    private var transmitting = false
    private var authenticated = false
    private var pendingBytes = 0
    private var lastReceived = Date()
    private var expectedCode = ""
    private var input = Data()
    private let tapLock = NSLock()
    private var pendingTaps = 0

    private func currentRevision(invalidate: Bool = false) -> Int {
        revisionLock.lock()
        defer { revisionLock.unlock() }
        if invalidate { revision += 1 }
        return revision
    }

    private func publish(_ token: Int, _ action: @escaping (USBClient) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.currentRevision() == token else { return }
            action(self)
        }
    }

    func start(code: String) {
        let token = currentRevision(invalidate: true)
        queue.async { [weak self] in
            guard let self = self, self.currentRevision() == token else { return }
            self.cleanUp()
            self.expectedCode = code
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 23456)
                let listener = try NWListener(using: parameters)
                self.listener = listener
                listener.stateUpdateHandler = { [weak self, weak listener] state in
                    guard let self = self, let listener = listener, self.listener === listener else { return }
                    if case .failed(let error) = state { self.fail(error, token: token) }
                }
                listener.newConnectionHandler = { [weak self, weak listener] connection in
                    guard let self = self, let listener = listener, self.listener === listener, self.connection == nil else { connection.cancel(); return }
                    self.accept(connection, token: token)
                }
                listener.start(queue: self.queue)
            } catch { self.fail(error, token: token) }
        }
    }

    private func accept(_ connection: NWConnection, token: Int) {
        self.connection = connection
        authenticated = false
        input.removeAll(keepingCapacity: true)
        pendingBytes = 0
        lastReceived = Date()
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self = self, let connection = connection, self.connection === connection else { return }
            switch state {
            case .ready: self.receive(connection, token: token)
            case .failed, .cancelled: self.lostConnection(token: token)
            default: break
            }
        }
        connection.start(queue: queue)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self, weak connection] in
            guard let self = self, let connection = connection, self.connection === connection else { return }
            if Date().timeIntervalSince(self.lastReceived) > (self.authenticated ? 10 : 4) {
                self.lostConnection(token: token)
            } else if self.authenticated { self.sendJSON(["type": "ping"], token: token) }
        }
        heartbeat = timer
        timer.resume()
    }

    private func receive(_ connection: NWConnection, token: Int) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self, weak connection] data, _, complete, error in
            guard let self = self, let connection = connection, self.connection === connection else { return }
            do {
                if let data = data {
                    self.input.append(data)
                    while self.input.count >= 4 {
                        let size = self.input.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
                        guard size > 0, size <= 65536 else { throw PocketError.message("USB 数据帧无效。") }
                        if self.input.count < size + 4 { break }
                        let payload = Data(self.input.dropFirst(4).prefix(size))
                        self.input = Data(self.input.dropFirst(size + 4))
                        try self.handle(payload, token: token)
                        if self.connection !== connection { return }
                    }
                }
                if complete || error != nil { self.lostConnection(token: token) }
                else { self.receive(connection, token: token) }
            } catch { self.lostConnection(token: token) }
        }
    }

    private func handle(_ payload: Data, token: Int) throws {
        guard payload.first == 1,
              let message = try JSONSerialization.jsonObject(with: Data(payload.dropFirst())) as? [String: Any] else {
            throw PocketError.message("USB 控制消息无效。")
        }
        lastReceived = Date()
        if !authenticated {
            guard message["type"] as? String == "hello",
                  message["protocol"] as? String == "pocketlink-usb-v1",
                  message["code"] as? String == expectedCode else {
                lostConnection(token: token)
                return
            }
            authenticated = true
            sendJSON(["type": "ready", "protocol": "pocketlink-usb-v1"], token: token)
            publish(token) { $0.onConnected?() }
        } else if message["type"] as? String == "control", let value = message["message"] as? [String: Any] {
            publish(token) { $0.onControl?(value) }
        }
    }

    private func sendJSON(_ value: [String: Any], token: Int) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        var payload = Data([1])
        payload.append(data)
        send(payload, token: token, audio: false)
    }

    private func send(_ payload: Data, token: Int, audio: Bool) {
        guard currentRevision() == token, let connection = connection, authenticated, payload.count <= 65536 else { return }
        // Drop audio under backpressure; never accumulate seconds of stale voice.
        if pendingBytes > 65536 {
            if !audio { fail(PocketError.message("USB 发送拥堵，请重新连接。"), token: token) }
            return
        }
        var size = UInt32(payload.count).bigEndian
        var packet = withUnsafeBytes(of: &size) { Data($0) }
        packet.append(payload)
        let count = packet.count
        pendingBytes += count
        connection.send(content: packet, completion: .contentProcessed { [weak self, weak connection] error in
            guard let self = self, let connection = connection, self.connection === connection else { return }
            self.pendingBytes -= count
            if let error = error { self.fail(error, token: token) }
        })
    }

    @discardableResult func sendControl(_ value: [String: Any]) -> Bool {
        let token = currentRevision()
        queue.async { [weak self] in self?.sendJSON(["type": "control", "message": value], token: token) }
        return true
    }

    func setMicrophone(_ enabled: Bool, keepAlive: Bool = false, completion: @escaping (Result<Void, Error>) -> Void) {
        let token = currentRevision()
        queue.async { [weak self] in
            guard let self = self, self.currentRevision() == token else { return }
            do {
                guard self.authenticated else { throw PocketError.message("USB 已断开，请重新配对。") }
                self.transmitting = enabled
                if enabled || keepAlive {
                    if self.engine == nil { try self.startAudio(token: token) }
                } else { self.stopAudio() }
                guard self.currentRevision() == token else { throw CancellationError() }
                self.publish(token) { _ in completion(.success(())) }
            } catch {
                self.stopAudio()
                self.publish(token) { _ in completion(.failure(error)) }
            }
        }
    }

    private func startAudio(token: Int) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setPreferredSampleRate(48000)
        try session.setPreferredIOBufferDuration(0.01)
        try session.setActive(true)
        audioActive = true
        guard currentRevision() == token else { throw CancellationError() }
        let engine = AVAudioEngine()
        self.engine = engine
        let node = engine.inputNode
        try node.setVoiceProcessingEnabled(true)
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate >= 8000, format.sampleRate <= 192000, format.channelCount > 0,
              format.commonFormat == .pcmFormatFloat32 else { throw PocketError.message("当前麦克风音频格式不受支持。") }
        node.installTap(onBus: 0, bufferSize: 480, format: format) { [weak self, weak engine] buffer, _ in
            guard let self = self, let engine = engine, let channels = buffer.floatChannelData else { return }
            self.tapLock.lock()
            if self.pendingTaps >= 4 { self.tapLock.unlock(); return }
            self.pendingTaps += 1
            self.tapLock.unlock()
            // Copy samples while AVAudioEngine owns the buffer. Queue only bounded packets.
            let frames = Int(buffer.frameLength)
            var payload = Data([2])
            var rate = UInt32(buffer.format.sampleRate).littleEndian
            withUnsafeBytes(of: &rate) { payload.append(contentsOf: $0) }
            for frame in 0..<frames {
                var sample: Float = 0
                for channel in 0..<Int(buffer.format.channelCount) { sample += channels[channel][frame * buffer.stride] }
                sample /= Float(buffer.format.channelCount)
                let clamped = sample.isFinite ? max(-1, min(1, sample)) : 0
                var pcm = Int16(clamped * 32767).littleEndian
                withUnsafeBytes(of: &pcm) { payload.append(contentsOf: $0) }
            }
            let packet = payload
            self.queue.async { [weak self, weak engine] in
                guard let self = self else { return }
                self.tapLock.lock(); self.pendingTaps -= 1; self.tapLock.unlock()
                guard let engine = engine, self.engine === engine, self.transmitting else { return }
                self.send(packet, token: token, audio: true)
            }
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()
    }

    private func stopAudio() {
        transmitting = false
        if let engine = engine {
            engine.stop()
            if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
            self.engine = nil
        }
        if audioActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioActive = false
        }
    }

    private func lostConnection(token: Int) {
        if authenticated { fail(PocketError.message("USB 连接已断开，请插线并重新配对。"), token: token) }
        else {
            heartbeat?.cancel(); heartbeat = nil
            let old = connection; connection = nil; old?.cancel()
            input.removeAll()
        }
    }
    private func fail(_ error: Error, token: Int) {
        cleanUp()
        publish(token) { $0.onError?(error) }
    }
    private func cleanUp() {
        heartbeat?.cancel(); heartbeat = nil
        let old = connection; connection = nil; old?.cancel()
        let oldListener = listener; listener = nil; oldListener?.cancel()
        authenticated = false
        input.removeAll()
        stopAudio()
    }
    func close() {
        _ = currentRevision(invalidate: true)
        queue.async { [weak self] in self?.cleanUp() }
    }
}
