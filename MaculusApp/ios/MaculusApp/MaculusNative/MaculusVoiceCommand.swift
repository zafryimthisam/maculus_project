import AVFoundation
import Foundation
import React
import UIKit

@objc(MaculusVoiceCommand)
final class MaculusVoiceCommand: RCTEventEmitter {
  private let wakeQueue = DispatchQueue(label: "com.maculus.wake", qos: .userInitiated)
  private var wakeEngine: MaculusWakeWordEngine?
  private var wakeAudioEngine: AVAudioEngine?
  private var audioConverter: AVAudioConverter?
  private var converterSourceRate: Double = 0
  private var converterSourceChannels: AVAudioChannelCount = 0
  private var wakeSamples: [Float] = []
  private var lastPredictionAt: TimeInterval = 0
  private var lastWakeAt: TimeInterval = 0
  private var wakeEnabled = false
  private var pausedForTts = false
  private var hasEventListeners = false
  private var bargeAudioEngine: AVAudioEngine?
  private var bargeLoudBufferCount = 0
  private var bargeTriggered = false

  override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(applicationDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(applicationWillEnterForeground),
      name: UIApplication.willEnterForegroundNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    stopBargeInAudio()
    stopWakeAudio()
  }

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    ["MaculusVoiceWakeDetected", "MaculusVoiceBargeInDetected", "MaculusVoiceCommandState", "MaculusVoiceCommandError"]
  }

  override func startObserving() { hasEventListeners = true }

  override func stopObserving() { hasEventListeners = false }

  @objc func isAvailable(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    let wakeAvailable = ["melspectrogram", "embedding_model", "hey_livekit"].allSatisfy {
      (try? MaculusResources.path($0, extension: "onnx")) != nil
    }
    resolve([
      "available": wakeAvailable,
      "wakeAvailable": wakeAvailable,
      // Command transcription is provided by ExecuTorch Whisper in JavaScript.
      "commandAvailable": true,
      "wakeWord": "Hey LiveKit",
    ])
  }

  @objc func startWakeListening(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    requestPermissions { granted in
      guard granted else {
        self.emitError("Microphone permission is needed", fatal: true)
        reject(
          "VOICE_PERMISSION_DENIED",
          "Microphone permission is needed",
          nil
        )
        return
      }
      self.wakeEnabled = true
      self.pausedForTts = false
      self.wakeQueue.async {
        do {
          if self.wakeEngine == nil { self.wakeEngine = try MaculusWakeWordEngine() }
          try self.startWakeAudio()
          self.emitState("wake_listening")
          resolve(["started": true, "wakeWord": "Hey LiveKit"])
        } catch {
          self.wakeEnabled = false
          self.emitError(error.localizedDescription, fatal: true)
          reject("WAKE_START_FAILED", error.localizedDescription, error)
        }
      }
    }
  }

  @objc func stopVoiceControl(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    wakeEnabled = false
    pausedForTts = false
    stopBargeInAudio()
    stopWakeAudio()
    emitState("off")
    resolve(nil)
  }

  @objc func pauseForTts(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    pausedForTts = true
    stopBargeInAudio()
    stopWakeAudio()
    emitState(wakeEnabled ? "paused" : "off")
    resolve(nil)
  }

  @objc func interruptForEmergency(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      self.pausedForTts = true
      self.stopBargeInAudio()
      self.stopWakeAudio()
      self.emitState(self.wakeEnabled ? "paused" : "off")
      resolve(nil)
    }
  }

  @objc func resumeAfterTts(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    pausedForTts = false
    stopBargeInAudio()
    guard wakeEnabled else {
      resolve(nil)
      return
    }
    wakeQueue.async {
      do {
        try self.startWakeAudio()
        self.emitState("wake_listening")
        resolve(nil)
      } catch {
        self.emitError(error.localizedDescription, fatal: false)
        reject("WAKE_RESUME_FAILED", error.localizedDescription, error)
      }
    }
  }

  @objc func startBargeInMonitoring(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard self.wakeEnabled else {
        resolve(nil)
        return
      }
      do {
        self.stopWakeAudio()
        try self.startBargeInAudio()
        self.emitState("paused")
        resolve(nil)
      } catch {
        self.stopBargeInAudio()
        reject("BARGE_IN_START_FAILED", error.localizedDescription, error)
      }
    }
  }

  @objc func stopBargeInMonitoring(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      self.stopBargeInAudio()
      resolve(nil)
    }
  }

  private func startWakeAudio() throws {
    if wakeAudioEngine?.isRunning == true { return }
    stopBargeInAudio()
    try configureAudioSession()
    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw MaculusNativeError.message("Microphone returned an invalid audio format")
    }
    wakeSamples.removeAll(keepingCapacity: true)
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.consume(buffer: buffer)
    }
    engine.prepare()
    try engine.start()
    wakeAudioEngine = engine
  }

  private func stopWakeAudio() {
    guard let engine = wakeAudioEngine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    wakeAudioEngine = nil
    audioConverter = nil
  }

  private func startBargeInAudio() throws {
    if bargeAudioEngine?.isRunning == true { return }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .voiceChat,
      options: [.duckOthers, .allowBluetooth, .defaultToSpeaker]
    )
    try session.setActive(true)
    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    try inputNode.setVoiceProcessingEnabled(true)
    let format = inputNode.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw MaculusNativeError.message("Microphone returned an invalid barge-in audio format")
    }
    bargeLoudBufferCount = 0
    bargeTriggered = false
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.consumeBargeIn(buffer: buffer)
    }
    engine.prepare()
    try engine.start()
    bargeAudioEngine = engine
  }

  private func stopBargeInAudio() {
    guard let engine = bargeAudioEngine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    bargeAudioEngine = nil
    bargeLoudBufferCount = 0
    bargeTriggered = false
  }

  private func consumeBargeIn(buffer: AVAudioPCMBuffer) {
    guard !bargeTriggered,
          let channel = buffer.floatChannelData?[0],
          buffer.frameLength > 0 else { return }
    let count = Int(buffer.frameLength)
    var sum: Float = 0
    for index in 0..<count {
      let sample = channel[index]
      sum += sample * sample
    }
    let rms = sqrt(sum / Float(count))
    bargeLoudBufferCount = rms >= 0.045 ? bargeLoudBufferCount + 1 : 0
    guard bargeLoudBufferCount >= 6 else { return }
    bargeTriggered = true
    DispatchQueue.main.async {
      self.stopBargeInAudio()
      self.emit("MaculusVoiceBargeInDetected", body: ["confidence": min(1, rms * 10)])
    }
  }

  private func consume(buffer: AVAudioPCMBuffer) {
    guard let samples = convertedSamples(buffer: buffer), !samples.isEmpty else { return }
    wakeQueue.async {
      guard self.wakeEnabled, !self.pausedForTts else { return }
      self.wakeSamples.append(contentsOf: samples)
      if self.wakeSamples.count > 32_000 {
        self.wakeSamples.removeFirst(self.wakeSamples.count - 32_000)
      }
      let now = Date().timeIntervalSince1970
      guard self.wakeSamples.count == 32_000,
            now - self.lastPredictionAt >= 0.1,
            now - self.lastWakeAt >= 2 else { return }
      self.lastPredictionAt = now
      do {
        if let detection = try self.wakeEngine?.predict(samples: self.wakeSamples) {
          self.lastWakeAt = now
          self.stopWakeAudio()
          self.emitState("wake_detected")
          self.emit("MaculusVoiceWakeDetected", body: [
            "name": detection.name,
            "label": "Hey LiveKit",
            "confidence": detection.confidence,
          ])
        }
      } catch {
        self.emitError(error.localizedDescription, fatal: false)
      }
    }
  }

  private func convertedSamples(buffer: AVAudioPCMBuffer) -> [Float]? {
    let outputFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false
    )!
    if buffer.format.sampleRate == 16_000,
       buffer.format.channelCount == 1,
       let channel = buffer.floatChannelData?[0] {
      return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    }
    if audioConverter == nil ||
       converterSourceRate != buffer.format.sampleRate ||
       converterSourceChannels != buffer.format.channelCount {
      audioConverter = AVAudioConverter(from: buffer.format, to: outputFormat)
      converterSourceRate = buffer.format.sampleRate
      converterSourceChannels = buffer.format.channelCount
    }
    guard let converter = audioConverter else { return nil }
    let capacity = AVAudioFrameCount(
      ceil(Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate) + 32
    )
    guard let converted = AVAudioPCMBuffer(
      pcmFormat: outputFormat,
      frameCapacity: capacity
    ) else { return nil }
    var supplied = false
    var conversionError: NSError?
    converter.convert(to: converted, error: &conversionError) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    guard conversionError == nil, let channel = converted.floatChannelData?[0] else { return nil }
    return Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
  }

  private func configureAudioSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .measurement,
      options: [.duckOthers, .allowBluetooth, .defaultToSpeaker]
    )
    try session.setActive(true)
  }

  private func requestPermissions(completion: @escaping (Bool) -> Void) {
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted:
      completion(true)
    case .undetermined:
      AVAudioSession.sharedInstance().requestRecordPermission(completion)
    default:
      completion(false)
    }
  }

  private func emitState(_ state: String) {
    emit("MaculusVoiceCommandState", body: ["state": state])
  }

  private func emitError(_ message: String, fatal: Bool) {
    emit("MaculusVoiceCommandError", body: ["message": message, "fatal": fatal])
  }

  private func emit(_ name: String, body: Any) {
    guard hasEventListeners else { return }
    DispatchQueue.main.async { self.sendEvent(withName: name, body: body) }
  }

  @objc private func applicationDidEnterBackground() {
    stopBargeInAudio()
    stopWakeAudio()
  }

  @objc private func applicationWillEnterForeground() {
    guard wakeEnabled, !pausedForTts else { return }
    wakeQueue.async {
      do {
        try self.startWakeAudio()
        self.emitState("wake_listening")
      } catch {
        self.emitError(error.localizedDescription, fatal: false)
      }
    }
  }
}
