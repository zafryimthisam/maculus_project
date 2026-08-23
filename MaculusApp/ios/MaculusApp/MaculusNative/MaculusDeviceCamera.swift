import AVFoundation
import Foundation
import ImageIO
import React
import UIKit

@objc(MaculusDeviceCamera)
final class MaculusDeviceCamera: NSObject, AVCapturePhotoCaptureDelegate {
  private let queue = DispatchQueue(label: "com.maculus.device-camera", qos: .userInitiated)
  private let session = AVCaptureSession()
  private let photoOutput = AVCapturePhotoOutput()
  private var configured = false
  private var desiredRunning = false
  private var lensFacing = "back"
  private var frameId: Int64 = 0
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
        reject("DEVICE_CAMERA_BUSY", "A phone camera frame is already being captured", nil)
        return
      }
      self.pendingCapture = (resolve, reject)
      let settings: AVCapturePhotoSettings
      if self.photoOutput.availablePhotoCodecTypes.contains(.jpeg) {
        settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      } else {
        settings = AVCapturePhotoSettings()
      }
      settings.flashMode = .off
      settings.photoQualityPrioritization = .speed
      if let connection = self.photoOutput.connection(with: .video),
         connection.isVideoOrientationSupported {
        connection.videoOrientation = Self.captureOrientation()
      }
      self.photoOutput.capturePhoto(with: settings, delegate: self)
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
      resolve(nil)
    }
  }

  func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishProcessingPhoto photo: AVCapturePhoto,
    error: Error?
  ) {
    queue.async {
      guard let pending = self.pendingCapture else { return }
      self.pendingCapture = nil
      if let error {
        pending.reject("DEVICE_CAMERA_CAPTURE_ERROR", error.localizedDescription, error)
        return
      }
      guard let data = photo.fileDataRepresentation(), !data.isEmpty else {
        pending.reject("DEVICE_CAMERA_CAPTURE_ERROR", "Phone camera returned an empty frame", nil)
        return
      }
      self.frameId += 1
      let dimensions = Self.pixelDimensions(data: data)
      let resolution: Any = dimensions.map { "\($0.width)x\($0.height)" } ?? NSNull()
      pending.resolve([
        "base64": data.base64EncodedString(),
        "frameId": self.frameId,
        "capturedAt": Date().timeIntervalSince1970 * 1000,
        "resolution": resolution,
        "lensFacing": self.lensFacing,
      ])
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
    guard session.canAddInput(input), session.canAddOutput(photoOutput) else {
      throw MaculusNativeError.message("The phone camera cannot create a capture session")
    }
    session.addInput(input)
    session.addOutput(photoOutput)
    photoOutput.isHighResolutionCaptureEnabled = false
    configured = true
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

  private static func pixelDimensions(data: Data) -> (width: Int, height: Int)? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
      return nil
    }
    return (width.intValue, height.intValue)
  }

  @objc private func applicationDidEnterBackground() {
    queue.async {
      if let pending = self.pendingCapture {
        self.pendingCapture = nil
        pending.reject("DEVICE_CAMERA_INTERRUPTED", "Phone camera was interrupted", nil)
      }
      if self.session.isRunning { self.session.stopRunning() }
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
