import AVFoundation
import SwiftUI
import UIKit

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }
    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "pocketlink.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var wanted = false // Accessed only on camera queue.
    private var scanned = false // Accessed only on main queue.

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let preview = AVCaptureVideoPreviewLayer(session: capture)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        queue.async { self.wanted = true }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            guard let self = self else { return }
            guard allowed else {
                self.showError("请在 Settings → PocketLink → Camera 允许相机，或返回手动输入配对码。")
                return
            }
            self.queue.async {
                guard self.wanted else { return }
                do {
                    if self.capture.inputs.isEmpty {
                        guard let camera = AVCaptureDevice.default(for: .video) else {
                            throw PocketError.message("没有可用相机，请使用真机或手动配对。")
                        }
                        let input = try AVCaptureDeviceInput(device: camera)
                        let output = AVCaptureMetadataOutput()
                        self.capture.beginConfiguration()
                        guard self.capture.canAddInput(input) else {
                            self.capture.commitConfiguration()
                            throw PocketError.message("无法开启相机。")
                        }
                        self.capture.addInput(input)
                        guard self.capture.canAddOutput(output) else {
                            self.capture.removeInput(input)
                            self.capture.commitConfiguration()
                            throw PocketError.message("相机不支持扫码。")
                        }
                        self.capture.addOutput(output)
                        output.setMetadataObjectsDelegate(self, queue: .main)
                        output.metadataObjectTypes = [.qr]
                        self.capture.commitConfiguration()
                    }
                    self.capture.startRunning()
                } catch { self.showError(error.localizedDescription) }
            }
        }
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        queue.async {
            self.wanted = false
            self.capture.stopRunning()
        }
    }
    private func showError(_ text: String) {
        DispatchQueue.main.async {
            let label = UILabel()
            label.text = text
            label.textColor = .white
            label.numberOfLines = 0
            label.textAlignment = .center
            label.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(label)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: self.view.leadingAnchor, constant: 24),
                label.trailingAnchor.constraint(equalTo: self.view.trailingAnchor, constant: -24),
                label.centerYAnchor.constraint(equalTo: self.view.centerYAnchor)
            ])
        }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !scanned, let text = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        scanned = true
        onCode?(text)
    }
}
