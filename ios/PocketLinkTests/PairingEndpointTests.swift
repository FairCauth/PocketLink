import XCTest
@testable import PocketLink

final class PairingEndpointTests: XCTestCase {
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
