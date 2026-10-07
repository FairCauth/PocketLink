import Foundation
import CryptoKit
import Security

struct PairingEndpoint: Equatable {
    let base: URL
    let code: String
    let mode: String
    let fingerprint: String?

    init(server: String, code: String, mode: String = "lan", fingerprint: String? = nil) throws {
        let cleanedCode = code.filter { !$0.isWhitespace }
        guard cleanedCode.range(of: "^[0-9]{8}$", options: .regularExpression) != nil else {
            throw PocketError.message("请输入 8 位配对码。")
        }
        guard var parts = URLComponents(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              ["lan", "server", "usb"].contains(mode) else {
            throw PocketError.message("请输入电脑显示的 HTTPS 地址，例如 https://192.168.1.20:8787。")
        }
        parts.path = ""
        guard let base = parts.url else { throw PocketError.message("服务器地址无效。") }
        self.base = base
        self.code = cleanedCode
        self.mode = mode
        if let fingerprint = fingerprint {
            guard fingerprint.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil else {
                throw PocketError.message("配对二维码的证书指纹无效，请在电脑刷新配对码。")
            }
        }
        self.fingerprint = fingerprint?.lowercased()
    }

    init(qr: String) throws {
        guard var parts = URLComponents(string: qr),
              let fragment = parts.fragment,
              let fields = URLComponents(string: "https://pair.invalid/?" + fragment)?.queryItems,
              fields.filter({ $0.name == "pair" }).count == 1,
              let code = fields.first(where: { $0.name == "pair" })?.value else {
            throw PocketError.message("请扫描电脑接收页的配对二维码。")
        }
        parts.fragment = nil
        guard let server = parts.url?.absoluteString else { throw PocketError.message("二维码无效。") }
        guard fields.filter({ $0.name == "mode" }).count <= 1,
              fields.filter({ $0.name == "fp" }).count <= 1,
              !fields.contains(where: { $0.name == "fp" && $0.value == nil }) else {
            throw PocketError.message("二维码连接方式无效。")
        }
        try self.init(server: server, code: code, mode: fields.first(where: { $0.name == "mode" })?.value ?? "lan",
                      fingerprint: fields.first(where: { $0.name == "fp" })?.value)
    }

    var signaling: URL {
        var parts = URLComponents(url: base.appendingPathComponent("signal"), resolvingAgainstBaseURL: false)!
        parts.scheme = "wss"
        return parts.url!
    }
}

// Each connection has its own immutable trust policy and URLSession (no trust/pool
// shared between computers). The QR is the out-of-band source of the leaf pin.
final class PairingTrust: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let endpoint: PairingEndpoint
    init(endpoint: PairingEndpoint) { self.endpoint = endpoint }

    func accepts(_ trust: SecTrust, host: String, port: Int) -> Bool {
        let normalizedHost = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        guard normalizedHost == endpoint.base.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased(),
              port == (endpoint.base.port ?? 443),
              let pin = endpoint.fingerprint,
              let leaf = SecTrustGetCertificateAtIndex(trust, 0) else { return false }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }.joined()
        guard digest == pin else { return false }
        // Pinning grants trust only to this certificate, while SSL policy still
        // validates the hostname and certificate validity. Never accept-all.
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, normalizedHost as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [leaf] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else { return false }
        SecTrustSetNetworkFetchAllowed(trust, false)
        return SecTrustEvaluateWithError(trust, nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              endpoint.fingerprint != nil else {
            completionHandler(.performDefaultHandling, nil); return
        }
        guard let trust = challenge.protectionSpace.serverTrust,
              accepts(trust, host: challenge.protectionSpace.host, port: challenge.protectionSpace.port) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }
}

enum PocketError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}

struct SoundPreset: Identifiable, Decodable {
    let id: String
    let name: String
}
