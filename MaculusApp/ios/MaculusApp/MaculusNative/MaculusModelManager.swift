import CryptoKit
import Foundation
import Network
import React
import UIKit

@objc(MaculusModelManager)
final class MaculusModelManager: RCTEventEmitter, URLSessionDataDelegate {
  private static let filename = "LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf"
  private static let expectedSize: Int64 = 695_755_488
  private static let expectedSHA256 = "bb741ebb106d543e9de114b843a3d3d73d51c74b5801e69da2abde821a0cb3e1"
  private static let minimumFreeSpace: Int64 = 1_100_000_000
  private static let modelURL = URL(string:
    "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/afbd8eaeab5dd94ba0b079ebfb02517d19641e38/LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf?download=true"
  )!

  private let queue = DispatchQueue(label: "com.maculus.model-download", qos: .utility)
  private let pathMonitor = NWPathMonitor()
  private var metered = true
  private var hasListeners = false
  private var task: URLSessionDataTask?
  private var fileHandle: FileHandle?
  private var downloadedBytes: Int64 = 0
  private var completion: (resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock)?
  private var cancelled = false
  private var memoryPressureUntil: Date?
  private lazy var session = URLSession(
    configuration: .default,
    delegate: self,
    delegateQueue: nil
  )

  override init() {
    super.init()
    pathMonitor.pathUpdateHandler = { [weak self] path in
      self?.metered = path.isExpensive || path.isConstrained
    }
    pathMonitor.start(queue: queue)
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(thermalStateChanged),
      name: ProcessInfo.thermalStateDidChangeNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(memoryWarning),
      name: UIApplication.didReceiveMemoryWarningNotification,
      object: nil
    )
  }

  deinit {
    task?.cancel()
    fileHandle?.closeFile()
    session.invalidateAndCancel()
    pathMonitor.cancel()
    NotificationCenter.default.removeObserver(self)
  }

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    ["MaculusModelDownloadProgress"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  @objc private func thermalStateChanged() {
    queue.async { self.emitCapability() }
  }

  @objc private func memoryWarning() {
    queue.async {
      self.memoryPressureUntil = Date().addingTimeInterval(60)
      self.emitCapability()
    }
  }

  @objc func getStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      do { resolve(try self.status()) }
      catch { reject("MODEL_STATUS_FAILED", error.localizedDescription, error) }
    }
  }

  @objc func startDownload(
    _ allowCellular: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      do {
        if self.isInstalled() {
          resolve(try self.status(forcedState: "ready"))
          return
        }
        if !allowCellular && self.metered {
          reject(
            "MODEL_CELLULAR_CONFIRMATION_REQUIRED",
            "Connect to Wi-Fi or confirm cellular download.",
            nil
          )
          return
        }
        try self.modelDirectory().createDirectoryIfNeeded()
        guard try self.availableCapacity() >= Self.minimumFreeSpace else {
          reject(
            "MODEL_INSUFFICIENT_STORAGE",
            "At least 1.1 GB of free app storage is required.",
            nil
          )
          return
        }
        if self.task != nil {
          resolve(try self.status(forcedState: "downloading"))
          return
        }
        self.cancelled = false
        self.completion = (resolve, reject)
        let partial = try self.partURL()
        if !FileManager.default.fileExists(atPath: partial.path) {
          FileManager.default.createFile(atPath: partial.path, contents: nil)
        }
        self.downloadedBytes = (try? partial.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        if self.downloadedBytes >= Self.expectedSize {
          try FileManager.default.removeItem(at: partial)
          FileManager.default.createFile(atPath: partial.path, contents: nil)
          self.downloadedBytes = 0
        }
        var request = URLRequest(url: Self.modelURL)
        request.timeoutInterval = 30
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if self.downloadedBytes > 0 {
          request.setValue("bytes=\(self.downloadedBytes)-", forHTTPHeaderField: "Range")
        }
        self.task = self.session.dataTask(with: request)
        self.task?.resume()
        self.emit(state: "downloading")
      } catch {
        self.completion = nil
        reject("MODEL_DOWNLOAD_FAILED", error.localizedDescription, error)
      }
    }
  }

  @objc func cancelDownload(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      self.cancelled = true
      self.task?.cancel()
      self.task = nil
      self.fileHandle?.closeFile()
      self.fileHandle = nil
      self.completion?.reject("MODEL_DOWNLOAD_CANCELLED", "Model download cancelled.", nil)
      self.completion = nil
      self.emit(state: "paused")
      do { resolve(try self.status(forcedState: "paused")) }
      catch { reject("MODEL_STATUS_FAILED", error.localizedDescription, error) }
    }
  }

  @objc func deleteModel(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      self.cancelled = true
      self.task?.cancel()
      self.task = nil
      self.fileHandle?.closeFile()
      self.fileHandle = nil
      do {
        for url in [try self.modelURL(), try self.partURL()] where FileManager.default.fileExists(atPath: url.path) {
          try FileManager.default.removeItem(at: url)
        }
        resolve(try self.status(forcedState: "missing"))
      } catch {
        reject("MODEL_DELETE_FAILED", error.localizedDescription, error)
      }
    }
  }

  func urlSession(
    _: URLSession,
    dataTask _: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    queue.async {
      do {
        guard let http = response as? HTTPURLResponse, (200 ... 299).contains(http.statusCode) else {
          throw ModelDownloadError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        let partial = try self.partURL()
        if self.downloadedBytes > 0 && http.statusCode != 206 {
          try Data().write(to: partial, options: .atomic)
          self.downloadedBytes = 0
        }
        self.fileHandle = try FileHandle(forWritingTo: partial)
        self.fileHandle?.seekToEndOfFile()
        completionHandler(.allow)
      } catch {
        completionHandler(.cancel)
        self.finish(error: error)
      }
    }
  }

  func urlSession(_: URLSession, dataTask _: URLSessionDataTask, didReceive data: Data) {
    queue.async {
      guard !self.cancelled else { return }
      self.fileHandle?.write(data)
      self.downloadedBytes += Int64(data.count)
      if self.downloadedBytes % (2 * 1024 * 1024) < Int64(data.count) {
        self.emit(state: "downloading")
      }
    }
  }

  func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError error: Error?) {
    queue.async {
      self.fileHandle?.synchronizeFile()
      self.fileHandle?.closeFile()
      self.fileHandle = nil
      self.task = nil
      if self.cancelled { return }
      if let error { self.finish(error: error); return }
      do {
        let partial = try self.partURL()
        guard self.downloadedBytes == Self.expectedSize else {
          throw ModelDownloadError.size(self.downloadedBytes)
        }
        guard try self.sha256(partial) == Self.expectedSHA256 else {
          try? FileManager.default.removeItem(at: partial)
          throw ModelDownloadError.checksum
        }
        let installed = try self.modelURL()
        if FileManager.default.fileExists(atPath: installed.path) {
          try FileManager.default.removeItem(at: installed)
        }
        try FileManager.default.moveItem(at: partial, to: installed)
        self.emit(state: "ready")
        self.completion?.resolve(try self.status(forcedState: "ready"))
        self.completion = nil
      } catch {
        self.finish(error: error)
      }
    }
  }

  private func finish(error: Error) {
    task?.cancel()
    task = nil
    fileHandle?.closeFile()
    fileHandle = nil
    emit(state: "error", message: error.localizedDescription)
    completion?.reject("MODEL_DOWNLOAD_FAILED", error.localizedDescription, error)
    completion = nil
  }

  private func status(forcedState: String? = nil) throws -> [String: Any] {
    let installed = isInstalled()
    let partial = try partURL()
    let partialBytes = (try? partial.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
    let state = forcedState ?? (installed ? "ready" : partialBytes > 0 ? "paused" : "missing")
    let capability = conversationalCapability()
    let thermal = thermalStatus()
    return [
      "state": state,
      "path": installed ? try modelURL().path : NSNull(),
      "downloadedBytes": installed ? Self.expectedSize : partialBytes,
      "totalBytes": Self.expectedSize,
      "metered": metered,
      "conversationalSupported": capability.supported,
      "capabilityReason": capability.reason.map { $0 as Any } ?? NSNull(),
      "thermalThrottled": thermal.throttled,
      "thermalState": thermal.name,
    ]
  }

  private func emit(state: String, message: String? = nil) {
    guard hasListeners else { return }
    var body: [String: Any] = [
      "state": state,
      "downloadedBytes": downloadedBytes,
      "totalBytes": Self.expectedSize,
    ]
    if let message { body["message"] = message }
    sendEvent(withName: "MaculusModelDownloadProgress", body: body)
  }

  private func emitCapability() {
    guard hasListeners else { return }
    let capability = conversationalCapability()
    let thermal = thermalStatus()
    sendEvent(withName: "MaculusModelDownloadProgress", body: [
      "conversationalSupported": capability.supported,
      "capabilityReason": capability.reason.map { $0 as Any } ?? NSNull(),
      "thermalThrottled": thermal.throttled,
      "thermalState": thermal.name,
    ])
  }

  private func modelDirectory() throws -> URL {
    let root = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    return root.appendingPathComponent("MaculusModels", isDirectory: true)
  }

  private func modelURL() throws -> URL { try modelDirectory().appendingPathComponent(Self.filename) }
  private func partURL() throws -> URL { try modelDirectory().appendingPathComponent("\(Self.filename).part") }

  private func isInstalled() -> Bool {
    guard let url = try? modelURL(), FileManager.default.fileExists(atPath: url.path) else { return false }
    return ((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0) == Self.expectedSize
  }

  private func availableCapacity() throws -> Int64 {
    let values = try modelDirectory().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values.volumeAvailableCapacityForImportantUsage ?? 0
  }

  private func conversationalCapability() -> (supported: Bool, reason: String?) {
    if let until = memoryPressureUntil, until > Date() {
      return (false, "Memory pressure paused the conversational model.")
    }
    if ProcessInfo.processInfo.physicalMemory < 3_000_000_000 {
      return (false, "Not enough memory is available for the conversational model.")
    }
    if ProcessInfo.processInfo.thermalState == .critical {
      return (false, "The device reached the critical thermal safety limit. Conversational guidance will resume after it cools.")
    }
    return (true, nil)
  }

  private func thermalStatus() -> (name: String, throttled: Bool) {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return ("nominal", false)
    case .fair: return ("fair", false)
    case .serious: return ("serious", true)
    case .critical: return ("critical", false)
    @unknown default: return ("unknown", false)
    }
  }

  private func sha256(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { handle.closeFile() }
    var hasher = SHA256()
    while autoreleasepool(invoking: {
      let data = handle.readData(ofLength: 1024 * 1024)
      if data.isEmpty { return false }
      hasher.update(data: data)
      return true
    }) {}
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

private enum ModelDownloadError: LocalizedError {
  case http(Int)
  case size(Int64)
  case checksum

  var errorDescription: String? {
    switch self {
    case let .http(code): return "Download server returned HTTP \(code)."
    case let .size(size): return "Downloaded model has unexpected size \(size)."
    case .checksum: return "Downloaded model checksum did not match provenance."
    }
  }
}

private extension URL {
  func createDirectoryIfNeeded() throws {
    try FileManager.default.createDirectory(at: self, withIntermediateDirectories: true)
  }
}
