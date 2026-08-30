import CryptoKit
import Foundation
import Network
import React
import UIKit

@objc(MaculusModelManager)
final class MaculusModelManager: RCTEventEmitter, URLSessionDataDelegate {
  private struct DownloadAsset {
    let label: String
    let filename: String
    let expectedSize: Int64
    let expectedSHA256: String
    let sourceURL: URL
  }

  private static let assets = [
    DownloadAsset(
      label: "vision language model",
      filename: "LFM2.5-VL-1.6B-Q4_K_M.gguf",
      expectedSize: 730_896_256,
      expectedSHA256: "aefc3c97c9eb30d9c0dd6af4c38250f5f5106b57c8cf92de7914c7d0a9c94da2",
      sourceURL: URL(string:
        "https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-GGUF/resolve/36fc16bc95133424921bcc3da009e83b2f23ffb5/LFM2.5-VL-1.6B-Q4_K_M.gguf?download=true"
      )!
    ),
    DownloadAsset(
      label: "vision encoder",
      filename: "mmproj-LFM2.5-VL-1.6b-Q8_0.gguf",
      expectedSize: 583_109_888,
      expectedSHA256: "2ce89e610c56f3198ece2b86cf61743a08b9307279c89125eb2412ebb908689d",
      sourceURL: URL(string:
        "https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-GGUF/resolve/36fc16bc95133424921bcc3da009e83b2f23ffb5/mmproj-LFM2.5-VL-1.6b-Q8_0.gguf?download=true"
      )!
    ),
  ]
  private static let minimumFreeSpaceAfterDownload: Int64 = 550_000_000
  private static let legacyFilenames = ["LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf"]
  private static var totalSize: Int64 { assets.reduce(0) { $0 + $1.expectedSize } }

  private let queue = DispatchQueue(label: "com.maculus.model-download", qos: .utility)
  private let pathMonitor = NWPathMonitor()
  private var metered = true
  private var hasListeners = false
  private var task: URLSessionDataTask?
  private var fileHandle: FileHandle?
  private var activeAssetIndex: Int?
  private var activeDownloadedBytes: Int64 = 0
  private var completion: (resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock)?
  private var cancelled = false
  private var memoryPressureUntil: Date?
  private var verifiedInstalledFingerprints: [String: String] = [:]
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
            "Connect to Wi-Fi or confirm the 1.3 GB private vision model download.",
            nil
          )
          return
        }
        try self.modelDirectory().createDirectoryIfNeeded()
        try self.removeLegacyAssets()
        try self.removeInvalidInstalledAssets()
        let required = try self.remainingDownloadBytes() + Self.minimumFreeSpaceAfterDownload
        guard try self.availableCapacity() >= required else {
          let gigabytes = Double(required) / 1_000_000_000
          reject(
            "MODEL_INSUFFICIENT_STORAGE",
            String(format: "At least %.1f GB of free app storage is required.", gigabytes),
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
        try self.startNextMissingAsset()
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
      self.activeAssetIndex = nil
      self.activeDownloadedBytes = 0
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
      self.activeAssetIndex = nil
      self.activeDownloadedBytes = 0
      self.verifiedInstalledFingerprints.removeAll()
      self.completion?.reject("MODEL_DOWNLOAD_CANCELLED", "Model download cancelled because the model was removed.", nil)
      self.completion = nil
      do {
        for asset in Self.assets {
          for url in [try self.installedURL(asset), try self.partialURL(asset)]
          where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
          }
        }
        try self.removeLegacyAssets()
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
        guard let asset = self.activeAsset else {
          throw ModelDownloadError.noActiveAsset
        }
        guard let http = response as? HTTPURLResponse, (200 ... 299).contains(http.statusCode) else {
          throw ModelDownloadError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        let partial = try self.partialURL(asset)
        if self.activeDownloadedBytes > 0 && http.statusCode != 206 {
          try Data().write(to: partial, options: .atomic)
          self.activeDownloadedBytes = 0
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
      self.activeDownloadedBytes += Int64(data.count)
      if self.activeDownloadedBytes % (2 * 1024 * 1024) < Int64(data.count) {
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
        guard let asset = self.activeAsset else { throw ModelDownloadError.noActiveAsset }
        let partial = try self.partialURL(asset)
        guard self.activeDownloadedBytes == asset.expectedSize else {
          throw ModelDownloadError.size(asset.label, self.activeDownloadedBytes)
        }
        guard try self.sha256(partial) == asset.expectedSHA256 else {
          try? FileManager.default.removeItem(at: partial)
          throw ModelDownloadError.checksum(asset.label)
        }
        let installed = try self.installedURL(asset)
        if FileManager.default.fileExists(atPath: installed.path) {
          try FileManager.default.removeItem(at: installed)
        }
        try FileManager.default.moveItem(at: partial, to: installed)
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
          ofItemAtPath: installed.path
        )
        self.verifiedInstalledFingerprints[asset.filename] = self.fileFingerprint(installed)
        self.activeAssetIndex = nil
        self.activeDownloadedBytes = 0
        try self.startNextMissingAsset()
      } catch {
        self.finish(error: error)
      }
    }
  }

  private var activeAsset: DownloadAsset? {
    guard let index = activeAssetIndex, Self.assets.indices.contains(index) else { return nil }
    return Self.assets[index]
  }

  private func startNextMissingAsset() throws {
    guard let index = Self.assets.indices.first(where: { !isAssetInstalled(Self.assets[$0]) }) else {
      activeAssetIndex = nil
      activeDownloadedBytes = 0
      emit(state: "ready")
      completion?.resolve(try status(forcedState: "ready"))
      completion = nil
      return
    }
    let asset = Self.assets[index]
    activeAssetIndex = index
    let partial = try partialURL(asset)
    if !FileManager.default.fileExists(atPath: partial.path) {
      FileManager.default.createFile(atPath: partial.path, contents: nil)
    }
    activeDownloadedBytes = fileSize(partial)
    if activeDownloadedBytes >= asset.expectedSize {
      try FileManager.default.removeItem(at: partial)
      FileManager.default.createFile(atPath: partial.path, contents: nil)
      activeDownloadedBytes = 0
    }
    var request = URLRequest(url: asset.sourceURL)
    request.timeoutInterval = 30
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    if activeDownloadedBytes > 0 {
      request.setValue("bytes=\(activeDownloadedBytes)-", forHTTPHeaderField: "Range")
    }
    task = session.dataTask(with: request)
    task?.resume()
    emit(state: "downloading")
  }

  private func finish(error: Error) {
    task?.cancel()
    task = nil
    fileHandle?.closeFile()
    fileHandle = nil
    activeAssetIndex = nil
    activeDownloadedBytes = 0
    emit(state: "error", message: error.localizedDescription)
    completion?.reject("MODEL_DOWNLOAD_FAILED", error.localizedDescription, error)
    completion = nil
  }

  private func status(forcedState: String? = nil) throws -> [String: Any] {
    let installed = isInstalled()
    let progress = try progressBytes()
    let hasPartial = progress > installedBytes()
    let state = forcedState ?? (installed ? "ready" : task != nil ? "downloading" : hasPartial ? "paused" : "missing")
    let capability = assistantCapability()
    let thermal = thermalStatus()
    return [
      "state": state,
      "path": installed ? try installedURL(Self.assets[0]).path : NSNull(),
      "projectorPath": installed ? try installedURL(Self.assets[1]).path : NSNull(),
      "downloadedBytes": installed ? Self.totalSize : progress,
      "totalBytes": Self.totalSize,
      "metered": metered,
      "modelName": "LFM2.5-VL-1.6B",
      "currentAsset": activeAsset.map { $0.label as Any } ?? NSNull(),
      "conversationalSupported": capability.supported,
      "visionSupported": capability.supported,
      "capabilityReason": capability.reason.map { $0 as Any } ?? NSNull(),
      "thermalThrottled": thermal.throttled,
      "thermalState": thermal.name,
    ]
  }

  private func emit(state: String, message: String? = nil) {
    guard hasListeners else { return }
    do {
      var body = try status(forcedState: state)
      if let message { body["message"] = message }
      sendEvent(withName: "MaculusModelDownloadProgress", body: body)
    } catch {
      sendEvent(withName: "MaculusModelDownloadProgress", body: [
        "state": "error",
        "message": error.localizedDescription,
      ])
    }
  }

  private func emitCapability() {
    guard hasListeners else { return }
    let capability = assistantCapability()
    let thermal = thermalStatus()
    sendEvent(withName: "MaculusModelDownloadProgress", body: [
      "conversationalSupported": capability.supported,
      "visionSupported": capability.supported,
      "capabilityReason": capability.reason.map { $0 as Any } ?? NSNull(),
      "thermalThrottled": thermal.throttled,
      "thermalState": thermal.name,
    ])
  }

  private func modelDirectory() throws -> URL {
    var root = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    ).appendingPathComponent("MaculusModels", isDirectory: true)
    try root.createDirectoryIfNeeded()
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? root.setResourceValues(values)
    return root
  }

  private func installedURL(_ asset: DownloadAsset) throws -> URL {
    try modelDirectory().appendingPathComponent(asset.filename)
  }

  private func partialURL(_ asset: DownloadAsset) throws -> URL {
    try modelDirectory().appendingPathComponent("\(asset.filename).part")
  }

  private func isInstalled() -> Bool {
    Self.assets.allSatisfy(isAssetInstalled)
  }

  private func isAssetInstalled(_ asset: DownloadAsset) -> Bool {
    guard let url = try? installedURL(asset), FileManager.default.fileExists(atPath: url.path) else { return false }
    guard fileSize(url) == asset.expectedSize else {
      verifiedInstalledFingerprints[asset.filename] = nil
      return false
    }
    let fingerprint = fileFingerprint(url)
    if fingerprint != nil && fingerprint == verifiedInstalledFingerprints[asset.filename] { return true }
    guard (try? sha256(url)) == asset.expectedSHA256 else {
      verifiedInstalledFingerprints[asset.filename] = nil
      return false
    }
    verifiedInstalledFingerprints[asset.filename] = fingerprint
    return true
  }

  private func removeInvalidInstalledAssets() throws {
    for asset in Self.assets {
      let url = try installedURL(asset)
      if FileManager.default.fileExists(atPath: url.path), !isAssetInstalled(asset) {
        try FileManager.default.removeItem(at: url)
      }
    }
  }

  private func removeLegacyAssets() throws {
    let directory = try modelDirectory()
    for filename in Self.legacyFilenames {
      for candidate in [filename, "\(filename).part"] {
        let url = directory.appendingPathComponent(candidate)
        if FileManager.default.fileExists(atPath: url.path) {
          try FileManager.default.removeItem(at: url)
        }
      }
    }
  }

  private func progressBytes() throws -> Int64 {
    try Self.assets.reduce(0) { total, asset in
      if isAssetInstalled(asset) { return total + asset.expectedSize }
      return total + min(fileSize(try partialURL(asset)), asset.expectedSize)
    }
  }

  private func installedBytes() -> Int64 {
    Self.assets.reduce(0) { $0 + (isAssetInstalled($1) ? $1.expectedSize : 0) }
  }

  private func remainingDownloadBytes() throws -> Int64 {
    Self.totalSize - (try progressBytes())
  }

  private func fileSize(_ url: URL) -> Int64 {
    (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
  }

  private func fileFingerprint(_ url: URL) -> String? {
    guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
          let size = values.fileSize,
          let modified = values.contentModificationDate else { return nil }
    return "\(size):\(modified.timeIntervalSince1970)"
  }

  private func availableCapacity() throws -> Int64 {
    let values = try modelDirectory().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values.volumeAvailableCapacityForImportantUsage ?? 0
  }

  private func assistantCapability() -> (supported: Bool, reason: String?) {
    if let until = memoryPressureUntil, until > Date() {
      return (false, "Memory pressure paused detailed vision and conversation.")
    }
    if ProcessInfo.processInfo.physicalMemory < 4_000_000_000 {
      return (false, "This device has too little memory for the high-accuracy vision model.")
    }
    if ProcessInfo.processInfo.thermalState == .critical {
      return (false, "The device reached its thermal safety limit. Detailed vision will resume after it cools.")
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
  case size(String, Int64)
  case checksum(String)
  case noActiveAsset

  var errorDescription: String? {
    switch self {
    case let .http(code): return "Download server returned HTTP \(code)."
    case let .size(asset, size): return "Downloaded \(asset) has unexpected size \(size)."
    case let .checksum(asset): return "Downloaded \(asset) checksum did not match provenance."
    case .noActiveAsset: return "The model downloader lost its active asset."
    }
  }
}

private extension URL {
  func createDirectoryIfNeeded() throws {
    try FileManager.default.createDirectory(at: self, withIntermediateDirectories: true)
  }
}
