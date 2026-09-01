import AVFoundation
import Foundation
import React
import Speech
import UIKit

@objc(MaculusVoiceCommand)
final class MaculusVoiceCommand: RCTEventEmitter {
  private let wakeQueue = DispatchQueue(label: "com.maculus.wake", qos: .userInitiated)
  private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
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

  private var commandAudioEngine: AVAudioEngine?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var commandTimeout: DispatchWorkItem?
  private var commandSilenceTimeout: DispatchWorkItem?
  private var commandAudioEnded = false
  private var latestCommandResult: [String: Any]?
  private var commandPromise: (
    resolve: RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  )?

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
    finishCommand(result: nil)
  }

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    ["MaculusVoiceWakeDetected", "MaculusVoiceBargeInDetected", "MaculusVoiceCommandTranscript", "MaculusVoiceCommandState", "MaculusVoiceCommandError"]
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
    let commandAvailable = speechRecognizer?.isAvailable == true &&
      speechRecognizer?.supportsOnDeviceRecognition == true
    resolve([
      "available": wakeAvailable && commandAvailable,
      "wakeAvailable": wakeAvailable,
      "commandAvailable": commandAvailable,
      "wakeWord": "Hey LiveKit",
    ])
  }

  @objc func startWakeListening(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    requestPermissions { granted in
      guard granted else {
        self.emitError("Microphone and speech recognition permissions are needed", fatal: true)
        reject(
          "VOICE_PERMISSION_DENIED",
          "Microphone and speech recognition permissions are needed",
          nil
        )
        return
      }
      guard self.speechRecognizer?.supportsOnDeviceRecognition == true else {
        reject(
          "VOICE_OFFLINE_UNAVAILABLE",
          "On-device speech recognition is unavailable for English on this iPhone",
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
    finishCommand(result: nil)
    emitState("off")
    resolve(nil)
  }

  @objc func listenForCommandOnce(
    _ timeoutMs: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      do {
        guard self.commandPromise == nil else {
          throw MaculusNativeError.message("Speech recognizer is already listening")
        }
        guard let recognizer = self.speechRecognizer,
              recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition else {
          throw MaculusNativeError.message("On-device speech recognition is unavailable")
        }
        self.stopWakeAudio()
        try self.configureAudioSession()

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.taskHint = .dictation
        request.contextualStrings = ["Hey LiveKit", "Maculus", "start guidance", "stop guidance", "describe scene"]
        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
          throw MaculusNativeError.message("Microphone returned an invalid audio format")
        }
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
          request.append(buffer)
        }
        self.commandAudioEngine = engine
        self.recognitionRequest = request
        self.latestCommandResult = nil
        self.commandAudioEnded = false
        engine.prepare()
        try engine.start()

        self.commandPromise = (resolve, reject)
        self.emitState("command_listening")
        self.recognitionTask = recognizer.recognitionTask(with: request) { result, error in
          DispatchQueue.main.async {
            if let result {
              let segments = result.bestTranscription.segments
              let confidence = segments.isEmpty
                ? nil
                : segments.reduce(Float(0)) { $0 + $1.confidence } / Float(segments.count)
              let bridgedConfidence: Any = confidence.map { NSNumber(value: $0) } ?? NSNull()
              let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
              if !text.isEmpty {
                self.latestCommandResult = ["text": text, "confidence": bridgedConfidence]
                self.emit("MaculusVoiceCommandTranscript", body: [
                  "text": text,
                  "confidence": bridgedConfidence,
                  "isFinal": result.isFinal,
                ])
                if !result.isFinal { self.scheduleCommandEndAfterSpeech() }
              }
              if result.isFinal { self.finishCommand(result: self.latestCommandResult) }
            } else if let error {
              if self.latestCommandResult != nil {
                self.finishCommand(result: self.latestCommandResult)
              } else {
                self.failCommand(error: error)
              }
            }
          }
        }

        let timeout = DispatchWorkItem { [weak self] in
          guard let strongSelf = self else { return }
          strongSelf.finishCommand(result: strongSelf.latestCommandResult)
        }
        self.commandTimeout = timeout
        DispatchQueue.main.asyncAfter(
          deadline: .now() + max(1, timeoutMs.doubleValue / 1000),
          execute: timeout
        )
      } catch {
        self.finishCommand(result: nil)
        reject("VOICE_COMMAND_START_ERROR", error.localizedDescription, error)
      }
    }
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
      self.finishCommand(result: nil)
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
    guard wakeEnabled, commandPromise == nil else {
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
      guard self.wakeEnabled, self.commandPromise == nil else {
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
    try session.setActive(true, options: .notifyOthersOnDeactivation)
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
      guard self.wakeEnabled, !self.pausedForTts, self.commandPromise == nil else { return }
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

  private func scheduleCommandEndAfterSpeech() {
    guard commandPromise != nil, !commandAudioEnded else { return }
    commandSilenceTimeout?.cancel()
    let silence = DispatchWorkItem { [weak self] in
      self?.endCommandAudioAfterSpeech()
    }
    commandSilenceTimeout = silence
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.1, execute: silence)
  }

  private func endCommandAudioAfterSpeech() {
    guard commandPromise != nil, latestCommandResult != nil, !commandAudioEnded else { return }
    commandAudioEnded = true
    commandSilenceTimeout = nil
    if let engine = commandAudioEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      commandAudioEngine = nil
    }
    // Apple requires live-buffer requests to receive endAudio() before they
    // can reliably deliver their final transcription.
    recognitionRequest?.endAudio()
  }

  private func finishCommand(result: [String: Any]?) {
    guard commandPromise != nil || commandAudioEngine != nil else { return }
    commandTimeout?.cancel()
    commandTimeout = nil
    commandSilenceTimeout?.cancel()
    commandSilenceTimeout = nil
    recognitionRequest?.endAudio()
    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest = nil
    if let engine = commandAudioEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    commandAudioEngine = nil
    commandAudioEnded = false
    let promise = commandPromise
    commandPromise = nil
    latestCommandResult = nil
    promise?.resolve(result)
  }

  private func failCommand(error: Error) {
    guard commandPromise != nil || commandAudioEngine != nil else { return }
    commandTimeout?.cancel()
    commandTimeout = nil
    commandSilenceTimeout?.cancel()
    commandSilenceTimeout = nil
    recognitionRequest?.endAudio()
    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest = nil
    if let engine = commandAudioEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    commandAudioEngine = nil
    commandAudioEnded = false
    let promise = commandPromise
    commandPromise = nil
    latestCommandResult = nil
    promise?.reject("VOICE_RECOGNITION_ERROR", error.localizedDescription, error)
  }

  private func configureAudioSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .measurement,
      options: [.duckOthers, .allowBluetooth, .defaultToSpeaker]
    )
    try session.setActive(true, options: .notifyOthersOnDeactivation)
  }

  private func requestPermissions(completion: @escaping (Bool) -> Void) {
    let requestSpeech: (Bool) -> Void = { microphoneGranted in
      guard microphoneGranted else { completion(false); return }
      SFSpeechRecognizer.requestAuthorization { status in
        completion(status == .authorized)
      }
    }
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted:
      requestSpeech(true)
    case .undetermined:
      AVAudioSession.sharedInstance().requestRecordPermission(requestSpeech)
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
    finishCommand(result: nil)
  }

  @objc private func applicationWillEnterForeground() {
    guard wakeEnabled, !pausedForTts, commandPromise == nil else { return }
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
