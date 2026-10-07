import AVFAudio
import Foundation
import WebRTC

// Public methods and callbacks run on main; audio lifecycle work is serialized off main.
final class RTCClient: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    var onSignal: (([String: Any]) -> Void)?
    var onState: ((String) -> Void)?
    var onControl: (([String: Any]) -> Void)?
    var onControlReady: (() -> Void)?
    var onError: ((Error) -> Void)?
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var track: RTCAudioTrack?
    private var pendingICE: [RTCIceCandidate] = []
    private var remoteReady = false
    private let audio = AudioCaptureController(driver: WebRTCAudioSessionDriver())

    override init() {
        super.init()
        let session = RTCAudioSession.sharedInstance()
        session.useManualAudio = true
        session.isAudioEnabled = false
    }

    func start(iceServers: [RTCIceServer], relay: Bool) throws {
        close()
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        config.iceServers = iceServers
        config.iceTransportPolicy = relay ? .relay : .all
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            throw PocketError.message("无法创建音频连接。")
        }
        self.peer = peer
        let source = Self.factory.audioSource(with: RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["googEchoCancellation": "true", "googNoiseSuppression": "true"]
        ))
        let track = Self.factory.audioTrack(with: source, trackId: "microphone")
        track.isEnabled = false
        self.track = track
        peer.add(track, streamIds: ["pocketlink"])
        let dataConfig = RTCDataChannelConfiguration()
        dataConfig.isOrdered = true
        guard let channel = peer.dataChannel(forLabel: "pocketlink-control-v1", configuration: dataConfig) else {
            throw PocketError.message("无法创建音效控制连接。")
        }
        self.channel = channel
        channel.delegate = self
        peer.offer(for: RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "false", "OfferToReceiveVideo": "false"], optionalConstraints: nil)) { [weak self] sdp, error in
            self?.onMain(peer) { client in
                guard let sdp = sdp, error == nil else {
                    client.onError?(error ?? PocketError.message("无法协商音频。")); return
                }
                peer.setLocalDescription(sdp) { [weak client] error in
                    client?.onMain(peer) { client in
                        if let error = error { client.onError?(error); return }
                        client.onSignal?(["type": "signal", "description": ["type": "offer", "sdp": sdp.sdp]])
                    }
                }
            }
        }
    }

    func receive(_ message: [String: Any]) {
        guard let peer = peer else { return }
        if let description = message["description"] as? [String: Any],
           description["type"] as? String == "answer", let sdp = description["sdp"] as? String {
            peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
                self?.onMain(peer) { client in
                    if let error = error { client.onError?(error); return }
                    client.remoteReady = true
                    client.pendingICE.forEach { client.addICE($0, to: peer) }
                    client.pendingICE.removeAll()
                }
            }
        }
        if let data = message["candidate"] as? [String: Any], let sdp = data["candidate"] as? String {
            let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: (data["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0, sdpMid: data["sdpMid"] as? String)
            if remoteReady { addICE(candidate, to: peer) } else { pendingICE.append(candidate) }
        }
    }

    private func addICE(_ candidate: RTCIceCandidate, to peer: RTCPeerConnection) {
        peer.add(candidate) { [weak self] error in
            if let error = error { self?.onMain(peer) { $0.onError?(error) } }
        }
    }

    func setMicrophone(_ enabled: Bool, keepAlive: Bool = false, completion: @escaping (Result<Void, Error>) -> Void) {
        guard let peer = peer, let track = track else {
            completion(.failure(PocketError.message("请先连接电脑。")))
            return
        }
        audio.setEnabled(enabled || keepAlive, transmitting: enabled, setTrack: { track.isEnabled = $0 }) { [weak self] result in
            guard let self = self, self.peer === peer else { return }
            completion(result)
        }
    }

    @discardableResult func sendControl(_ message: [String: Any]) -> Bool {
        guard channel?.readyState == .open, let data = try? JSONSerialization.data(withJSONObject: message) else { return false }
        return channel?.sendData(RTCDataBuffer(data: data, isBinary: false)) == true
    }

    func close() {
        let oldTrack = track
        let oldChannel = channel
        let oldPeer = peer
        oldChannel?.delegate = nil
        oldPeer?.delegate = nil
        channel = nil
        peer = nil
        track = nil
        pendingICE.removeAll()
        remoteReady = false
        // Queue teardown after pending audio changes, before the next session's activation.
        audio.close(setTrack: { oldTrack?.isEnabled = $0 }) {
            oldChannel?.close()
            oldPeer?.close()
        }
    }

    private func onMain(_ peer: RTCPeerConnection, _ action: @escaping (RTCClient) -> Void) {
        DispatchQueue.main.async { [weak self, weak peer] in
            guard let self = self, let peer = peer, self.peer === peer else { return }
            action(self)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onMain(peerConnection) { client in
            var value: [String: Any] = ["candidate": candidate.sdp, "sdpMLineIndex": candidate.sdpMLineIndex]
            if let mid = candidate.sdpMid { value["sdpMid"] = mid }
            client.onSignal?(["type": "signal", "candidate": value])
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        onMain(peerConnection) { client in
            switch newState {
            case .connected, .completed: client.onState?("connected")
            case .disconnected: client.onState?("reconnecting")
            case .failed: client.onError?(PocketError.message("音频连接失败，请检查网络或重新配对。"))
            default: break
            }
        }
    }
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.channel === dataChannel else { return }
            if dataChannel.readyState == .open { self.onControlReady?() }
        }
    }
    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary, buffer.data.count <= 65536,
              let message = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any] else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.channel === dataChannel else { return }
            self.onControl?(message)
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) { dataChannel.close() }
}

protocol AudioSessionDriver: AnyObject {
    func activate() throws
    func setAudioEnabled(_ enabled: Bool)
    func deactivate() throws
}

private final class WebRTCAudioSessionDriver: AudioSessionDriver {
    func activate() throws {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        let config = RTCAudioSessionConfiguration.webRTC()
        config.category = AVAudioSession.Category.playAndRecord.rawValue
        config.mode = AVAudioSession.Mode.voiceChat.rawValue
        config.categoryOptions = [.allowBluetooth, .defaultToSpeaker]
        try session.setConfiguration(config)
        try session.setActive(true)
    }

    func setAudioEnabled(_ enabled: Bool) {
        // Never hold the configuration lock here: WebRTC may synchronously wait
        // for its worker thread, which needs the same lock to start/stop audio.
        RTCAudioSession.sharedInstance().isAudioEnabled = enabled
    }

    func deactivate() throws {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try session.setActive(false)
    }
}

enum AudioLifecycle {
    static let queue = DispatchQueue(label: "pocketlink.audio-lifecycle", qos: .userInitiated)
}

final class AudioCaptureController {
    private let queue = AudioLifecycle.queue
    private let driver: AudioSessionDriver
    private var active = false // Accessed only on queue.
    private let revisionLock = NSLock()
    private var revision = 0

    init(driver: AudioSessionDriver) { self.driver = driver }

    func setEnabled(_ enabled: Bool, transmitting: Bool = true, setTrack: @escaping (Bool) -> Void,
                    completion: @escaping (Result<Void, Error>) -> Void) {
        let token = audioRevision(invalidate: !enabled)
        queue.async {
            let result: Result<Void, Error>
            do {
                // Mute before touching the audio unit, including mic -> standby transitions.
                if !transmitting { setTrack(false) }
                if enabled {
                    guard self.audioRevision() == token else { throw CancellationError() }
                    if !self.active {
                        try self.driver.activate()
                        self.active = true
                    }
                    guard self.audioRevision() == token else { throw CancellationError() }
                    self.driver.setAudioEnabled(true)
                    guard self.audioRevision() == token else { throw CancellationError() }
                    setTrack(transmitting)
                } else {
                    try self.stop(setTrack: setTrack)
                }
                result = .success(())
            } catch {
                try? self.stop(setTrack: setTrack)
                result = .failure(error)
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    func close(setTrack: @escaping (Bool) -> Void, closePeer: @escaping () -> Void) {
        _ = audioRevision(invalidate: true)
        queue.async {
            try? self.stop(setTrack: setTrack)
            closePeer()
        }
    }

    private func audioRevision(invalidate: Bool = false) -> Int {
        revisionLock.lock()
        defer { revisionLock.unlock() }
        if invalidate { revision += 1 }
        return revision
    }

    private func stop(setTrack: (Bool) -> Void) throws {
        setTrack(false)
        driver.setAudioEnabled(false)
        if active {
            active = false
            // RTCAudioSession balances its activation counter even on a failed
            // deactivation; do not decrement it again from error cleanup.
            try driver.deactivate()
        }
    }
}
