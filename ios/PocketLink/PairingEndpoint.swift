import Foundation

struct PairingEndpoint: Equatable {
    let base: URL
    let code: String
    let mode: String

    init(server: String, code: String, mode: String = "lan") throws {
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
        guard fields.filter({ $0.name == "mode" }).count <= 1 else {
            throw PocketError.message("二维码连接方式无效。")
        }
        try self.init(server: server, code: code, mode: fields.first(where: { $0.name == "mode" })?.value ?? "lan")
    }

    var signaling: URL {
        var parts = URLComponents(url: base.appendingPathComponent("signal"), resolvingAgainstBaseURL: false)!
        parts.scheme = "wss"
        return parts.url!
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
