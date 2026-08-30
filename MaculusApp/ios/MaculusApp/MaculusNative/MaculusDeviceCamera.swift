import AVFoundation
import CoreMotion
import CoreImage
import Foundation
import React
import UIKit

@objc(MaculusDeviceCamera)
final class MaculusDeviceCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private struct BufferedVideoFrame {
    let pixelBuffer: CVPixelBuffer
    let frameId: Int64
    let capturedAt: Double
  }

  private let queue = DispatchQueue(label: "com.maculus.device-camera", qos: .userInitiated)
  private let session = AVCaptureSession()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let imageContext = CIContext(options: [CIContextOption.cacheIntermediates: false])
  private var configured = false
  private var desiredRunning = false
  private var lensFacing = "back"
  private var frameId: Int64 = 0
  private var lastDeliveredFrameId: Int64 = 0
  private var latestFrame: BufferedVideoFrame?
  private var pendingCapture: (
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
    if session.isRunning { session.stopRunning() }
  }

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func startCamera(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    requestPermission { granted in
      guard granted else {
        reject(
          "DEVICE_CAMERA_PERMISSION_DENIED",
          "Camera permission is needed when the Raspberry Pi camera is unavailable",
          nil
        )
        return
      }
      self.queue.async {
        do {
          self.desiredRunning = true
          let alreadyStarted = self.session.isRunning
          if !self.configured { try self.configureSession() }
          if !self.session.isRunning { self.session.startRunning() }
          resolve([
            "started": true,
            "alreadyStarted": alreadyStarted,
            "lensFacing": self.lensFacing,
          ])
        } catch {
          self.desiredRunning = false
          reject("DEVICE_CAMERA_START_ERROR", error.localizedDescription, error)
        }
      }
    }
  }

  @objc func captureFrame(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      guard self.configured, self.session.isRunning else {
        reject("DEVICE_CAMERA_NOT_STARTED", "Phone camera is not started", nil)
        return
      }
      guard self.pendingCapture == nil else {
        reject("DEVICE_CAMERA_BUSY", "A phone camera frame is already being requested", nil)
        return
      }

      self.updateVideoOrientation()
      if let frame = self.latestFrame,
         frame.frameId > self.lastDeliveredFrameId {
        self.deliver(frame, resolve: resolve, reject: reject)
      } else {
        // Wait for the next sample from the already-running video stream. This
        // guarantees callers receive a new frame without invoking still-photo
        // capture (and therefore without shutter behavior).
        self.pendingCapture = (resolve, reject)
      }
    }
  }

  @objc func stopCamera(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      self.desiredRunning = false
      if let pending = self.pendingCapture {
        self.pendingCapture = nil
        pending.reject("DEVICE_CAMERA_STOPPED", "Phone camera stopped during capture", nil)
      }
      if self.session.isRunning { self.session.stopRunning() }
      self.latestFrame = nil
      self.lastDeliveredFrameId = self.frameId
      resolve(nil)
    }
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    // AVCaptureVideoDataOutput invokes this delegate on `queue`, so all frame
    // and promise state remains serialized without an additional lock.
    guard output === videoOutput,
          let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }

    frameId += 1
    let frame = BufferedVideoFrame(
      pixelBuffer: pixelBuffer,
      frameId: frameId,
      capturedAt: Date().timeIntervalSince1970 * 1000
    )
    latestFrame = frame

    if let pending = pendingCapture,
       frame.frameId > lastDeliveredFrameId {
      pendingCapture = nil
      deliver(frame, resolve: pending.resolve, reject: pending.reject)
    }
  }

  private func configureSession() throws {
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.sessionPreset = .vga640x480

    let device: AVCaptureDevice
    if let back = AVCaptureDevice.default(
      .builtInWideAngleCamera,
      for: .video,
      position: .back
    ) {
      device = back
      lensFacing = "back"
    } else if let front = AVCaptureDevice.default(
      .builtInWideAngleCamera,
      for: .video,
      position: .front
    ) {
      device = front
      lensFacing = "front"
    } else {
      throw MaculusNativeError.message("This device has no usable camera")
    }

    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input), session.canAddOutput(videoOutput) else {
      throw MaculusNativeError.message("The phone camera cannot create a capture session")
    }
    session.addInput(input)
    videoOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
    ]
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.setSampleBufferDelegate(self, queue: queue)
    session.addOutput(videoOutput)
    updateVideoOrientation()
    configured = true
  }

  private func deliver(
    _ frame: BufferedVideoFrame,
    resolve: RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let ciImage = CIImage(cvPixelBuffer: frame.pixelBuffer)
    guard let cgImage = imageContext.createCGImage(ciImage, from: ciImage.extent),
          let data = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.82),
          !data.isEmpty else {
      reject("DEVICE_CAMERA_CAPTURE_ERROR", "Phone camera could not encode the live frame", nil)
      return
    }

    lastDeliveredFrameId = frame.frameId
    resolve([
      "base64": data.base64EncodedString(),
      "frameId": frame.frameId,
      "capturedAt": frame.capturedAt,
      "resolution": "\(cgImage.width)x\(cgImage.height)",
      "lensFacing": lensFacing,
    ])
  }

  private func updateVideoOrientation() {
    if let connection = videoOutput.connection(with: .video),
       connection.isVideoOrientationSupported {
      connection.videoOrientation = Self.captureOrientation()
    }
  }

  private func requestPermission(completion: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      completion(true)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video, completionHandler: completion)
    default:
      completion(false)
    }
  }

  private static func captureOrientation() -> AVCaptureVideoOrientation {
    switch UIDevice.current.orientation {
    case .landscapeLeft: return .landscapeRight
    case .landscapeRight: return .landscapeLeft
    case .portraitUpsideDown: return .portraitUpsideDown
    default: return .portrait
    }
  }

  @objc private func applicationDidEnterBackground() {
    queue.async {
      if let pending = self.pendingCapture {
        self.pendingCapture = nil
        pending.reject("DEVICE_CAMERA_INTERRUPTED", "Phone camera was interrupted", nil)
      }
      if self.session.isRunning { self.session.stopRunning() }
      self.latestFrame = nil
      self.lastDeliveredFrameId = self.frameId
    }
  }

  @objc private func applicationWillEnterForeground() {
    queue.async {
      if self.desiredRunning, self.configured, !self.session.isRunning {
        self.session.startRunning()
      }
    }
  }
}

@objc(MaculusDeviceMotion)
final class MaculusDeviceMotion: NSObject {
  private let manager = CMMotionManager()
  private let queue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "com.maculus.device-motion"
    queue.qualityOfService = .userInteractive
    queue.maxConcurrentOperationCount = 1
    return queue
  }()
  private let lock = NSLock()
  private var monitoring = false
  private var peakRotationRate = 0.0
  private var peakAcceleration = 0.0
  private var lastSampleAt = 0.0

  @objc static func requiresMainQueueSetup() -> Bool { false }

  deinit {
    manager.stopDeviceMotionUpdates()
  }

  @objc func startMonitoring(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard manager.isDeviceMotionAvailable else {
      resolve(["available": false, "started": false])
      return
    }
    if monitoring {
      resolve(["available": true, "started": true, "alreadyStarted": true])
      return
    }
    manager.deviceMotionUpdateInterval = 1.0 / 50.0
    monitoring = true
    manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, error in
      guard let self else { return }
      if let error {
        self.lock.lock()
        self.monitoring = false
        self.lock.unlock()
        self.manager.stopDeviceMotionUpdates()
        NSLog("[MaculusMotion] Device motion stopped: %@", error.localizedDescription)
        return
      }
      guard let motion else { return }
      let rotation = motion.rotationRate
      let acceleration = motion.userAcceleration
      let rotationMagnitude = sqrt(
        rotation.x * rotation.x + rotation.y * rotation.y + rotation.z * rotation.z
      )
      let accelerationMagnitude = sqrt(
        acceleration.x * acceleration.x +
        acceleration.y * acceleration.y +
        acceleration.z * acceleration.z
      )
      self.lock.lock()
      self.peakRotationRate = max(self.peakRotationRate, rotationMagnitude)
      self.peakAcceleration = max(self.peakAcceleration, accelerationMagnitude)
      self.lastSampleAt = Date().timeIntervalSince1970 * 1000
      self.lock.unlock()
    }
    resolve(["available": true, "started": true, "alreadyStarted": false])
  }

  @objc func consumeMotionState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    lock.lock()
    let rotationRate = peakRotationRate
    let acceleration = peakAcceleration
    let sampledAt = lastSampleAt
    let active = monitoring
    peakRotationRate = 0
    peakAcceleration = 0
    lock.unlock()
    resolve([
      "available": manager.isDeviceMotionAvailable,
      "monitoring": active,
      "moving": active && (rotationRate >= 0.12 || acceleration >= 0.08),
      "rotationRate": rotationRate,
      "acceleration": acceleration,
      "sampledAt": sampledAt,
    ])
  }

  @objc func stopMonitoring(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    manager.stopDeviceMotionUpdates()
    lock.lock()
    monitoring = false
    peakRotationRate = 0
    peakAcceleration = 0
    lastSampleAt = 0
    lock.unlock()
    resolve(nil)
  }
}
