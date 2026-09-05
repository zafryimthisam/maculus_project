import Foundation
import React
import UIKit
import onnxruntime_objc

@objc(MaculusReId)
final class MaculusReId: NSObject {
  private let queue = DispatchQueue(label: "com.maculus.reid", qos: .utility, autoreleaseFrequency: .workItem)
  private var session: ORTSession?
  private let inputWidth = 128
  private let inputHeight = 256
  private let mean: [Float] = [0.485, 0.456, 0.406]
  private let standardDeviation: [Float] = [0.229, 0.224, 0.225]

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func loadModel(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      do {
        let alreadyLoaded = self.session != nil
        if self.session == nil {
          self.session = try MaculusORT.makeSession(resource: "person_reid_osnet_x0_25")
        }
        resolve([
          "available": true,
          "backend": "ONNX Runtime iOS",
          "inputWidth": self.inputWidth,
          "inputHeight": self.inputHeight,
          "embeddingSize": 512,
          "alreadyLoaded": alreadyLoaded,
        ])
      } catch {
        self.session = nil
        reject("REID_MODEL_LOAD_ERROR", error.localizedDescription, error)
      }
    }
  }

  @objc func embedPeople(
    _ base64Jpeg: String,
    detections: [[String: Any]],
    detectionIndices: [NSNumber],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      do {
        guard let session = self.session else {
          throw MaculusNativeError.message("ReID model is not loaded")
        }
        let image = try MaculusImage.decode(base64: base64Jpeg)
        var response: [[String: Any]] = []
        for number in detectionIndices {
          let detectionIndex = number.intValue
          guard detections.indices.contains(detectionIndex) else { continue }
          let crop = try self.personCrop(image: image, detection: detections[detectionIndex])
          let scaled = MaculusImage.resized(
            crop,
            width: self.inputWidth,
            height: self.inputHeight
          )
          let rgb = try MaculusImage.rgbBytes(scaled)
          let channelSize = self.inputWidth * self.inputHeight
          var input = [Float](repeating: 0, count: channelSize * 3)
          for pixel in 0..<channelSize {
            for channel in 0..<3 {
              let value = Float(rgb[pixel * 3 + channel]) / 255
              input[channel * channelSize + pixel] =
                (value - self.mean[channel]) / self.standardDeviation[channel]
            }
          }
          let output = try MaculusORT.runFloat(
            session: session,
            values: input,
            shape: [1, 3, self.inputHeight, self.inputWidth]
          )
          var embedding = output.values
          let magnitude = max(
            0.000001,
            embedding.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
          )
          for index in embedding.indices { embedding[index] /= magnitude }
          response.append([
            "detectionIndex": detectionIndex,
            "embedding": embedding,
          ])
        }
        resolve(response)
      } catch {
        reject("REID_EMBED_ERROR", error.localizedDescription, error)
      }
    }
  }

  private func personCrop(image: UIImage, detection: [String: Any]) throws -> UIImage {
    let rawX1 = detection.maculusDouble("x1", fallback: 0).clamped(to: 0...1)
    let rawY1 = detection.maculusDouble("y1", fallback: 0).clamped(to: 0...1)
    let rawX2 = detection.maculusDouble("x2", fallback: 1).clamped(to: 0...1)
    let rawY2 = detection.maculusDouble("y2", fallback: 1).clamped(to: 0...1)
    let left = min(rawX1, rawX2)
    let right = max(rawX1, rawX2)
    let top = min(rawY1, rawY2)
    let bottom = max(rawY1, rawY2)
    let widthPadding = (right - left) * 0.04
    let heightPadding = (bottom - top) * 0.02
    let x1 = (left - widthPadding).clamped(to: 0...1)
    let y1 = (top - heightPadding).clamped(to: 0...1)
    let x2 = (right + widthPadding).clamped(to: 0...1)
    let y2 = (bottom + heightPadding).clamped(to: 0...1)
    return try MaculusImage.cropped(
      image,
      normalizedRect: CGRect(
        x: CGFloat(x1),
        y: CGFloat(y1),
        width: CGFloat(x2 - x1),
        height: CGFloat(y2 - y1)
      )
    )
  }
}
