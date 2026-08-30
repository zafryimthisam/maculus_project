import FastVLM
import Foundation
import React
import UIKit

@objc(MaculusFastVLM)
final class MaculusFastVLMBridge: NSObject {
  private let taskLock = NSLock()
  private var currentTask: Task<Void, Never>?

  override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleMemoryWarning),
      name: UIApplication.didReceiveMemoryWarningNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    cancelCurrentTask()
  }

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func getStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(Self.status())
  }

  @objc func load(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard Self.capability().supported else {
      reject("FASTVLM_UNSUPPORTED", Self.capability().reason, nil)
      return
    }
    let task = Task(priority: .userInitiated) {
      do {
        try await MaculusFastVLMEngine.shared.load()
        try Task.checkCancellation()
        resolve([
          "ready": true,
          "modelName": MaculusFastVLMEngine.modelName,
          "backend": "Core ML + MLX",
        ])
      } catch is CancellationError {
        reject("FASTVLM_CANCELLED", "FastVLM loading was cancelled.", nil)
      } catch {
        reject("FASTVLM_LOAD_FAILED", error.localizedDescription, error)
      }
    }
    replaceCurrentTask(with: task)
  }

  @objc func generate(
    _ base64Jpeg: String?,
    prompt: String,
    maxTokens: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard Self.capability().supported else {
      reject("FASTVLM_UNAVAILABLE", Self.capability().reason, nil)
      return
    }
    let jpegData: Data?
    if let base64Jpeg, !base64Jpeg.isEmpty {
      let payload = base64Jpeg.components(separatedBy: ",").last ?? base64Jpeg
      guard let decoded = Data(base64Encoded: payload, options: .ignoreUnknownCharacters) else {
        reject("FASTVLM_INVALID_IMAGE", "FastVLM could not decode the camera frame.", nil)
        return
      }
      jpegData = decoded
    } else {
      jpegData = nil
    }

    cancelCurrentTask()
    let task = Task(priority: .userInitiated) {
      do {
        let result = try await MaculusFastVLMEngine.shared.generate(
          jpegData: jpegData,
          prompt: prompt,
          maxTokens: maxTokens.intValue
        )
        try Task.checkCancellation()
        resolve([
          "text": result.text,
          "timeToFirstTokenMs": result.timeToFirstTokenMs,
          "totalTimeMs": result.totalTimeMs,
          "modelName": MaculusFastVLMEngine.modelName,
        ])
      } catch is CancellationError {
        reject("FASTVLM_CANCELLED", "FastVLM generation was cancelled.", nil)
      } catch {
        reject("FASTVLM_INFERENCE_FAILED", error.localizedDescription, error)
      }
    }
    replaceCurrentTask(with: task)
  }

  @objc func cancel(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    cancelCurrentTask()
    resolve(true)
  }

  @objc func release(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    cancelCurrentTask()
    Task {
      await MaculusFastVLMEngine.shared.release()
      resolve(true)
    }
  }

  private func replaceCurrentTask(with task: Task<Void, Never>) {
    taskLock.lock()
    currentTask = task
    taskLock.unlock()
  }

  private func cancelCurrentTask() {
    taskLock.lock()
    let task = currentTask
    currentTask = nil
    taskLock.unlock()
    task?.cancel()
  }

  @objc private func handleMemoryWarning() {
    cancelCurrentTask()
    Task { await MaculusFastVLMEngine.shared.release() }
  }

  private static func capability() -> (supported: Bool, reason: String?) {
    if ProcessInfo.processInfo.physicalMemory < 5_000_000_000 {
      return (false, "FastVLM-1.5B requires an iPhone with at least 6 GB of memory.")
    }
    if ProcessInfo.processInfo.thermalState == .critical {
      return (false, "The iPhone is at its thermal safety limit. Let it cool before loading FastVLM.")
    }
    return (true, nil)
  }

  private static func status() -> [String: Any] {
    let capability = capability()
    let thermal = ProcessInfo.processInfo.thermalState
    let modelPath: Any = capability.supported ? "fastvlm://bundled" : NSNull()
    let projectorPath: Any = capability.supported ? "fastvlm://coreml" : NSNull()
    return [
      "state": capability.supported ? "ready" : "error",
      "path": modelPath,
      "projectorPath": projectorPath,
      "downloadedBytes": 0,
      "totalBytes": 0,
      "metered": false,
      "modelName": MaculusFastVLMEngine.modelName,
      "currentAsset": NSNull(),
      "conversationalSupported": capability.supported,
      "visionSupported": capability.supported,
      "capabilityReason": capability.reason.map { $0 as Any } ?? NSNull(),
      "thermalThrottled": thermal == .serious,
      "thermalState": thermalName(thermal),
      "bundled": true,
      "message": "Bundled for non-commercial research use under Apple's model license.",
    ]
  }

  private static func thermalName(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }
}
