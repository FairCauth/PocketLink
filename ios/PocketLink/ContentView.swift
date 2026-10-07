import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel
    @State private var scanning = false
    @State private var settings = false
    private let accent = Color(red: 0.78, green: 0.97, blue: 0.39)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    HStack {
                        Label("PocketLink", systemImage: "waveform")
                            .font(.headline)
                        Spacer()
                        if model.connected {
                            Circle().fill(model.checkingConnection ? Color.orange : accent).frame(width: 7, height: 7)
                            Text(model.checkingConnection ? "检查连接…" : "已连接").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Button { settings = true } label: { Image(systemName: "gearshape") }
                                .accessibilityLabel("连接设置")
                        }
                    }
                    if model.connected { controls } else { pairing }
                    if !model.message.isEmpty {
                        Text(model.message).font(.footnote).foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                .padding(24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(red: 0.055, green: 0.07, blue: 0.06))
            .toolbar(.hidden, for: .navigationBar)
            .tint(accent)
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    QRScanner { result in
                        scanning = false
                        model.scan(result)
                    }
                    .ignoresSafeArea(edges: .bottom)
                    .navigationTitle("扫描电脑配对码")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { scanning = false } } }
                }
            }
            .sheet(isPresented: $settings) {
                NavigationStack {
                    Form {
                        Section("连接") {
                            if model.connectionMode != "usb" { serverField }
                            Picker("连接方式", selection: $model.connectionMode) {
                                Text("无线").tag("lan")
                                Text("USB 有线").tag("usb")
                                Text("服务器中继").tag("server")
                            }
                        }
                        Section {
                            Text("同一 Wi-Fi 使用默认方式。跨网络连接需在电脑服务配置 TURN。")
                            Text("USB 有线：插线并信任电脑，运行 Start-PocketLink-USB.cmd，输入电脑的 USB 配对码。无需热点、Wi-Fi、局域网或手机根证书。Windows 需安装 Apple Devices。")
                            Text("USB 模式也需要开启麦克风或后台保持才能申请后台音频运行；电话和系统挂起仍可能中断。")
                            Text("无线模式首次连接需要信任电脑根证书。")
                        }.font(.footnote)
                    }
                    .navigationTitle("设置")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { settings = false } } }
                }
            }
        }
    }

    private var serverField: some View {
        TextField("https://电脑IP:8787", text: $model.server)
            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            .accessibilityLabel("电脑服务地址")
    }

    private var pairing: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("连接电脑").font(.largeTitle.bold())
                Text(model.connectionMode == "usb" ? "插入数据线，输入电脑配对码。" : "输入配对码，或扫一扫。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }.padding(.top, 36)
            Picker("连接方式", selection: $model.connectionMode) {
                Text("无线").tag("lan")
                Text("USB 有线").tag("usb")
                Text("中继").tag("server")
            }.pickerStyle(.segmented).disabled(model.busy)
            if model.connectionMode == "usb" {
                Text("电脑运行 Start-PocketLink-USB.cmd 并创建配对码。无需热点、Wi-Fi 或局域网。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            TextField("0000 0000", text: $model.code)
                .font(.system(size: 36, weight: .medium, design: .monospaced))
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .accessibilityLabel("8 位配对码")
                .onChange(of: model.code) { value in
                    let cleaned = String(value.filter { $0.isASCII && $0.isNumber }.prefix(8))
                    if cleaned != value { model.code = cleaned }
                }
                .padding(20).background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
            if model.connectionMode != "usb" {
                serverField.font(.subheadline)
                    .padding(16).background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
            }
            Button(action: model.connect) {
                HStack {
                    if model.busy { ProgressView().tint(.black) }
                    Text(model.busy ? "正在连接" : "连接").fontWeight(.semibold)
                }.frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent).foregroundStyle(.black)
            .disabled(model.busy || model.code.count != 8 || (model.connectionMode != "usb" && model.server.isEmpty))
            if model.busy {
                Button("取消连接", action: model.disconnect).frame(maxWidth: .infinity)
            } else if model.connectionMode != "usb" {
                Button { scanning = true } label: {
                    Label("扫码连接", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                }.buttonStyle(.bordered)
            }
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 24) {
            Button(action: model.toggleMicrophone) {
                VStack(spacing: 16) {
                    if model.requestingMicrophone {
                        ProgressView().controlSize(.large)
                    } else {
                        Image(systemName: model.microphone ? "mic.fill" : "mic.slash")
                            .font(.system(size: 42, weight: .light))
                    }
                    Text(model.requestingMicrophone ? "正在切换…" : (model.microphone ? "麦克风已开启" : "开启麦克风")).font(.title3.bold())
                    Text(model.microphone ? "点按关闭 · 可锁屏使用" : (model.keepAlive ? "后台待命 · 人声不发送" : "只播音效无需开启 · 锁屏可能暂停连接"))
                        .font(.footnote).opacity(0.65)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 32)
                .foregroundStyle(model.microphone ? Color.black : accent)
                .background(model.microphone ? accent : Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 24))
            }
            .buttonStyle(.plain)
            .disabled(model.requestingMicrophone)
            VStack(alignment: .leading, spacing: 8) {
                Toggle("保持后台开启", isOn: Binding(get: { model.keepAlive }, set: { _ in model.toggleKeepAlive() }))
                    .disabled(model.requestingMicrophone)
                Text("保持麦克风采集，系统会显示橙色指示。不开启上方麦克风时，人声不发送、不保存；会增加耗电。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !model.voices.isEmpty {
                Picker("变声", selection: Binding(get: { model.voice }, set: { model.selectVoice($0) })) {
                    ForEach(model.voices) { preset in Text(preset.name).tag(preset.id) }
                }.disabled(model.changingVoice || !model.controlReady)
                Text("同时处理手机与电脑麦克风，音效保持原音。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text("音效").font(.headline)
                Spacer()
                Button(action: model.refreshSounds) { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("刷新音效").disabled(!model.controlReady)
                Button("停止", action: model.stopSound).disabled(!model.controlReady)
            }
            if model.sounds.isEmpty {
                Text(model.controlReady ? "在电脑接收页添加音效，即可在这里播放。" : "正在连接音效控制，请确认电脑已更新…")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                ForEach(model.sounds) { sound in
                    Button { model.play(sound) } label: {
                        VStack(alignment: .leading, spacing: 18) {
                            Image(systemName: model.playingID == sound.id ? "stop.fill" : "play.fill")
                            Text(sound.name).font(.subheadline).lineLimit(2)
                        }
                        .frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
                        .padding(18)
                        .background(accent.opacity(model.playingID == sound.id ? 0.18 : 0.05), in: RoundedRectangle(cornerRadius: 18))
                    }.buttonStyle(.plain).disabled(!model.controlReady)
                }
            }
            Button("断开连接", action: model.disconnect)
                .font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity).padding(.top, 16)
        }.padding(.top, 12)
    }
}
