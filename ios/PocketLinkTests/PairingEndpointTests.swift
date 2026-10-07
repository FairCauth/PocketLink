import XCTest
import Security
import CryptoKit
@testable import PocketLink

final class PairingEndpointTests: XCTestCase {
    func testCertificatePinComesFromQRCode() throws {
        let pin = String(repeating: "AB", count: 32)
        let pair = try PairingEndpoint(qr: "https://192.168.1.20:8787/#pair=12345678&fp=\(pin)")
        XCTAssertEqual(pair.fingerprint, pin.lowercased())
        XCTAssertEqual(pair.signaling.absoluteString, "wss://192.168.1.20:8787/signal")
        XCTAssertNil(try PairingEndpoint(server: "https://host", code: "12345678").fingerprint)
        for field in ["fp=", "fp", "fp=abc", "fp=\(pin)&fp=\(pin)", "fp=\(String(repeating: "z", count: 64))"] {
            XCTAssertThrowsError(try PairingEndpoint(qr: "https://host/#pair=12345678&\(field)"))
        }
    }
    func testUSBQRCodeRetainsMode() throws {
        let pair = try PairingEndpoint(qr: "https://172.20.10.2:8787/#pair=12345678&mode=usb")
        XCTAssertEqual(pair.mode, "usb")
        XCTAssertEqual(pair.base.absoluteString, "https://172.20.10.2:8787")
        XCTAssertThrowsError(try PairingEndpoint(qr: "https://host/#pair=12345678&mode=usb&mode=lan"))
        XCTAssertThrowsError(try PairingEndpoint(qr: "https://host/#pair=12345678&mode=unknown"))
    }
    func testExistingReceiverQRCode() throws {
        let pair = try PairingEndpoint(qr: "https://192.168.1.20:8787/#pair=12345678")
        XCTAssertEqual(pair.code, "12345678")
        XCTAssertEqual(pair.base.absoluteString, "https://192.168.1.20:8787")
        XCTAssertEqual(pair.signaling.absoluteString, "wss://192.168.1.20:8787/signal")
    }
    func testManualCodeAllowsVisualSpacingAndIPv6() throws {
        let pair = try PairingEndpoint(server: "https://[::1]:8787/", code: "1234 5678", mode: "server")
        XCTAssertEqual(pair.code, "12345678")
        XCTAssertEqual(pair.mode, "server")
        XCTAssertEqual(pair.signaling.absoluteString, "wss://[::1]:8787/signal")
    }
    func testRejectsUnsafeOrAmbiguousEndpoints() {
        for url in ["http://192.168.1.20:8787", "https://user:password@host", "https://host/path", "https://host/?x=1", "https://host/#x", "file:///tmp"] {
            XCTAssertThrowsError(try PairingEndpoint(server: url, code: "12345678"), url)
        }
        for code in ["1234567", "123456789", "１２３４５６７８", "1234abcd"] {
            XCTAssertThrowsError(try PairingEndpoint(server: "https://host", code: code), code)
        }
        XCTAssertThrowsError(try PairingEndpoint(qr: "https://host/setup"))
        XCTAssertThrowsError(try PairingEndpoint(qr: "https://host/#pair=12345678&pair=87654321"))
        XCTAssertThrowsError(try PairingEndpoint(server: "https://host", code: "12345678", mode: "invalid"))
    }
}

final class AudioCaptureControllerTests: XCTestCase {
    func testStandbyCapturesWithoutEnablingTransmissionAndReusesAudioSession() {
        let driver = TestAudioDriver()
        let controller = AudioCaptureController(driver: driver)
        let standby = expectation(description: "standby ready")
        controller.setEnabled(true, transmitting: false, setTrack: { driver.record("track:\($0)") }) { result in
            if case .failure(let error) = result { XCTFail("\(error)") }
            standby.fulfill()
        }
        wait(for: [standby], timeout: 3)
        XCTAssertTrue(driver.events.contains("audio:true"))
        XCTAssertFalse(driver.events.contains("track:true"))
        let speaking = expectation(description: "transmission ready")
        controller.setEnabled(true, transmitting: true, setTrack: { driver.record("track:\($0)") }) { _ in speaking.fulfill() }
        wait(for: [speaking], timeout: 3)
        XCTAssertTrue(driver.events.contains("track:true"))
        let muted = expectation(description: "standby again")
        controller.setEnabled(true, transmitting: false, setTrack: { driver.record("track:\($0)") }) { _ in muted.fulfill() }
        wait(for: [muted], timeout: 3)
        XCTAssertEqual(driver.events.filter { $0 == "activate" }.count, 1)
        XCTAssertFalse(driver.events.contains("deactivate"))
        XCTAssertEqual(driver.events.last, "track:false")
        let closed = expectation(description: "audio released")
        controller.close(setTrack: { _ in }) { closed.fulfill() }
        wait(for: [closed], timeout: 3)
        XCTAssertEqual(driver.events.last, "deactivate")
    }
    func testSlowActivationDoesNotBlockMainAndCloseCancelsCapture() {
        let driver = TestAudioDriver()
        let entered = expectation(description: "activation started off main")
        let completed = expectation(description: "activation cancelled")
        let closed = expectation(description: "peer closed after audio stopped")
        let gate = DispatchSemaphore(value: 0)
        driver.onActivate = {
            entered.fulfill()
            XCTAssertEqual(gate.wait(timeout: .now() + 3), .success)
        }
        let controller = AudioCaptureController(driver: driver)
        controller.setEnabled(true, setTrack: { driver.record("track:\($0)") }) { result in
            XCTAssertTrue(Thread.isMainThread)
            if case .success = result { XCTFail("Closing during activation must cancel it") }
            completed.fulfill()
        }
        wait(for: [entered], timeout: 2)
        // The main thread can still handle Disconnect while AVAudioSession is busy.
        controller.close(setTrack: { driver.record("track:\($0)") }) {
            driver.record("close")
            closed.fulfill()
        }
        gate.signal()
        wait(for: [completed, closed], timeout: 3)
        XCTAssertFalse(driver.events.contains("track:true"))
        XCTAssertFalse(driver.events.contains("audio:true"))
        XCTAssertEqual(driver.events.filter { $0 == "deactivate" }.count, 1)
        XCTAssertEqual(driver.events.last, "close")
    }

    func testRepeatedEnableBalancesActivationAndStopsBeforeClosing() {
        let driver = TestAudioDriver()
        let controller = AudioCaptureController(driver: driver)
        let enabled = expectation(description: "enabled twice")
        enabled.expectedFulfillmentCount = 2
        for _ in 0..<2 {
            controller.setEnabled(true, setTrack: { driver.record("track:\($0)") }) { result in
                XCTAssertTrue(Thread.isMainThread)
                if case .failure(let error) = result { XCTFail("\(error)") }
                enabled.fulfill()
            }
        }
        wait(for: [enabled], timeout: 3)
        let closed = expectation(description: "closed")
        controller.close(setTrack: { driver.record("track:\($0)") }) {
            driver.record("close")
            closed.fulfill()
        }
        wait(for: [closed], timeout: 3)
        XCTAssertEqual(driver.events.filter { $0 == "activate" }.count, 1)
        XCTAssertEqual(Array(driver.events.suffix(4)), ["track:false", "audio:false", "deactivate", "close"])
    }

    func testActivationFailureNeverEnablesTrackAndCanRetry() {
        let driver = TestAudioDriver()
        driver.onActivate = { throw PocketError.message("Audio device unavailable") }
        let controller = AudioCaptureController(driver: driver)
        let failed = expectation(description: "error reaches UI")
        controller.setEnabled(true, setTrack: { driver.record("track:\($0)") }) { result in
            XCTAssertTrue(Thread.isMainThread)
            if case .success = result { XCTFail("Expected activation error") }
            failed.fulfill()
        }
        wait(for: [failed], timeout: 3)
        XCTAssertFalse(driver.events.contains("track:true"))
        XCTAssertFalse(driver.events.contains("deactivate"))
        driver.onActivate = nil
        let retried = expectation(description: "retry succeeds")
        controller.setEnabled(true, setTrack: { driver.record("track:\($0)") }) { result in
            if case .failure(let error) = result { XCTFail("\(error)") }
            retried.fulfill()
        }
        wait(for: [retried], timeout: 3)
        XCTAssertTrue(driver.events.contains("track:true"))
        let closed = expectation(description: "cleanup")
        controller.close(setTrack: { _ in }) { closed.fulfill() }
        wait(for: [closed], timeout: 3)
    }
}

private final class TestAudioDriver: AudioSessionDriver {
    private let lock = NSLock()
    private var recorded: [String] = []
    var onActivate: (() throws -> Void)?
    var events: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
    func record(_ event: String) {
        XCTAssertFalse(Thread.isMainThread, "Audio lifecycle must not block the UI")
        lock.lock()
        recorded.append(event)
        lock.unlock()
    }
    func activate() throws { record("activate"); try onActivate?() }
    func setAudioEnabled(_ enabled: Bool) { record("audio:\(enabled)") }
    func deactivate() throws { record("deactivate") }
}

// Public test certificate only. Both generated private keys were discarded.
final class PairingTrustTests: XCTestCase {
    private let certificateDER = "MIIDIDCCAgigAwIBAgIUWu+kdSSgen8qEMJMmJs1peyagT8wDQYJKoZIhvcNAQELBQAwKTEnMCUGA1UEAwweUG9ja2V0TGluayBYQ1Rlc3QgZXBoZW1lcmFsIENBMB4XDTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFowITEfMB0GA1UEAwwWUG9ja2V0TGluayBYQ1Rlc3Qgb25seTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJSVzERyXDcE45FQkiX96+BE4jiB4D3qtOvrDD5SbupUcFs1sMBBg/tUOFBTrIws5LbmT1J46m7gems/sJEczZZhg2vaJMwwHOeIMpPN8eMmmjCtMiKrnslNoRZDGbbKhcyoFKzntyX2WixZVf3pAY+M+x+AHLc2I9yKTAkt4tFxmZDalPHjerz4I7idSjUhIjemkHth7yoJvyKZlf5bsRz7DYfA/P5mvCpMcntZtbU5gGf5MTQf/RwDuxVc2BxypmCKm69DaP6cmC9BYBZje56IU+D+1hR305fGVEhVd8xOxSXdOKjWll3hqo9xK6/LDZ/zn3BlBfZ4e4h/oK5NWYcCAwEAAaNIMEYwDAYDVR0TAQH/BAIwADAhBgNVHREEGjAYhwR/AAABhxAAAAAAAAAAAAAAAAAAAAABMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA0GCSqGSIb3DQEBCwUAA4IBAQCUHC9uZCCNhc8GA6PfpQJ3JYcSEpc0bqR3APNiyz7xD2X9zCIAwQxb5CZ+98dXoX8STsC/aVmP9Ej2nU4GmHlXkcw9iOiEr++lV6ttjjkac7Vva08H/Www+SxLGEQDRX7RbMvPPbwRU/YQPG6cS2LYXhEGhH+mwIMvF+RlzvdzrO26ZQhXEIjmdi0EJ7EnD+VhoiEgLJF969jx819EPG/RA7Z8kwTcgKWbDmB36dfqEt5kISY2snuYllYMgWY9HKLNgBvXr7YnykKqXZ0Dp81BaIMQBpw3oruRZhi32Z1pbRArilOQu3nUwpqT20wkvV1x78tVlNtC9Pime6skMZ9m"

    private func certificate() throws -> SecCertificate {
        let data = try XCTUnwrap(Data(base64Encoded: certificateDER))
        return try XCTUnwrap(SecCertificateCreateWithData(nil, data as CFData))
    }
    private func trust(at time: TimeInterval = 1893456000) throws -> SecTrust {
        var value: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(try certificate(), SecPolicyCreateSSL(true, "127.0.0.1" as CFString), &value), errSecSuccess)
        let result = try XCTUnwrap(value)
        SecTrustSetVerifyDate(result, Date(timeIntervalSince1970: time) as CFDate)
        SecTrustSetNetworkFetchAllowed(result, false)
        return result
    }
    private func policy(host: String = "127.0.0.1", pin: String? = nil) throws -> PairingTrust {
        let digest = SHA256.hash(data: SecCertificateCopyData(try certificate()) as Data)
            .map { String(format: "%02x", $0) }.joined()
        return PairingTrust(endpoint: try PairingEndpoint(server: "https://\(host):8787", code: "12345678", fingerprint: pin ?? digest))
    }
    func testPinnedLeafWorksWithoutInstalledRoot() throws {
        XCTAssertFalse(SecTrustEvaluateWithError(try trust(), nil))
        XCTAssertTrue(try policy().accepts(trust(), host: "127.0.0.1", port: 8787))
        XCTAssertTrue(try policy(host: "[::1]").accepts(trust(), host: "::1", port: 8787))
    }
    func testRejectsReplacementWrongOriginWrongHostnameAndExpiry() throws {
        XCTAssertFalse(try policy(pin: String(repeating: "0", count: 64)).accepts(trust(), host: "127.0.0.1", port: 8787))
        XCTAssertFalse(try policy().accepts(trust(), host: "192.168.1.5", port: 8787))
        XCTAssertFalse(try policy().accepts(trust(), host: "127.0.0.1", port: 443))
        XCTAssertFalse(try policy(host: "192.168.1.5").accepts(trust(), host: "192.168.1.5", port: 8787))
        XCTAssertFalse(try policy().accepts(trust(at: 2208988800), host: "127.0.0.1", port: 8787))
        XCTAssertFalse(try policy().accepts(trust(at: 1577836800), host: "127.0.0.1", port: 8787))
    }
}
