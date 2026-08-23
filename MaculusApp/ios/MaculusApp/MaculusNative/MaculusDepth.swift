import Foundation
import React
import onnxruntime_objc

@objc(MaculusDepth)
final class MaculusDepth: NSObject {
  private let queue = DispatchQueue(label: "com.maculus.depth", qos: .utility)
  private var session: ORTSession?
  private let inputSize = 256
  private var outputWidth = 518
  private var outputHeight = 518

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func loadDepthModel(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      do {
        let alreadyLoaded = self.session != nil
        if self.session == nil {
          self.session = try MaculusORT.makeSession(
            resource: "depth_anything_v2_small_uint8_256"
          )
        }
        resolve([
          "backend": "ONNX Runtime iOS",
          "inputSize": self.inputSize,
          "outputWidth": self.outputWidth,
          "outputHeight": self.outputHeight,
          "available": true,
          "alreadyLoaded": alreadyLoaded,
        ])
      } catch {
        reject("DEPTH_MODEL_LOAD_ERROR", error.localizedDescription, error)
      }
    }
  }

  @objc func estimateDepth(
    _ base64Jpeg: String,
    detections: [[String: Any]],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      do {
        guard let session = self.session else {
          throw MaculusNativeError.message("Depth model is not loaded")
        }
        let image = try MaculusImage.decode(base64: base64Jpeg)
        let scaled = MaculusImage.resized(
          image,
          width: self.inputSize,
          height: self.inputSize
        )
        let rgb = try MaculusImage.rgbBytes(scaled)
        let output = try MaculusORT.runUInt8(
          session: session,
          values: rgb,
          shape: [1, self.inputSize, self.inputSize, 3]
        )
        self.updateOutputDimensions(shape: output.shape, count: output.values.count)
        let nearMap = try self.normalize(output.values)
        let objectDepths = detections.enumerated().map { index, detection in
          let cx = detection.maculusDouble("cx", fallback: 0.5)
          let cy = detection.maculusDouble("cy", fallback: 0.5)
          let width = detection.maculusDouble("w", fallback: 0)
          let height = detection.maculusDouble("h", fallback: 0)
          let x1 = detection.maculusDouble("x1", fallback: cx - width / 2)
          let y1 = detection.maculusDouble("y1", fallback: cy - height / 2)
          let x2 = detection.maculusDouble("x2", fallback: cx + width / 2)
          let y2 = detection.maculusDouble("y2", fallback: cy + height / 2)
          let innerX1 = x1 + (x2 - x1) * 0.25
          let innerY1 = y1 + (y2 - y1) * 0.25
          let innerX2 = x2 - (x2 - x1) * 0.25
          let innerY2 = y2 - (y2 - y1) * 0.25
          return [
            "index": index,
            "nearScore": self.sample(
              map: nearMap,
              x1: innerX1,
              y1: innerY1,
              x2: innerX2,
              y2: innerY2
            ),
          ] as [String: Any]
        }
        resolve([
          "width": self.outputWidth,
          "height": self.outputHeight,
          "leftNearScore": self.sample(map: nearMap, x1: 0, y1: 0, x2: 1.0 / 3.0, y2: 1),
          "centerNearScore": self.sample(map: nearMap, x1: 1.0 / 3.0, y1: 0, x2: 2.0 / 3.0, y2: 1),
          "rightNearScore": self.sample(map: nearMap, x1: 2.0 / 3.0, y1: 0, x2: 1, y2: 1),
          "objectDepths": objectDepths,
        ])
      } catch {
        reject("DEPTH_ESTIMATE_ERROR", error.localizedDescription, error)
      }
    }
  }

  private func updateOutputDimensions(shape: [Int], count: Int) {
    let dimensions = shape.filter { $0 > 1 }
    if dimensions.count >= 2 {
      outputHeight = dimensions[dimensions.count - 2]
      outputWidth = dimensions[dimensions.count - 1]
    }
    if outputWidth * outputHeight == count { return }
    let side = Int(Double(count).squareRoot())
    if side * side == count {
      outputWidth = side
      outputHeight = side
    } else if outputWidth > 0, count % outputWidth == 0 {
      outputHeight = count / outputWidth
    } else {
      outputWidth = max(count, 1)
      outputHeight = 1
    }
  }

  private func normalize(_ raw: [Float]) throws -> [Float] {
    guard !raw.isEmpty else {
      throw MaculusNativeError.message("Depth model returned an empty tensor")
    }
    let finite = raw.filter(\.isFinite)
    guard let minimum = finite.min(), let maximum = finite.max() else {
      throw MaculusNativeError.message("Depth model returned no finite values")
    }
    let range = max(0.000001, maximum - minimum)
    let count = outputWidth * outputHeight
    return (0..<count).map { index in
      let value = index < raw.count && raw[index].isFinite ? raw[index] : minimum
      return ((value - minimum) / range).clamped(to: 0...1)
    }
  }

  private func sample(
    map: [Float],
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double
  ) -> Double {
    let left = Int(min(x1, x2).clamped(to: 0...1) * Double(outputWidth))
      .clamped(to: 0...max(outputWidth - 1, 0))
    let right = Int(max(x1, x2).clamped(to: 0...1) * Double(outputWidth))
      .clamped(to: min(left + 1, outputWidth)...outputWidth)
    let top = Int(min(y1, y2).clamped(to: 0...1) * Double(outputHeight))
      .clamped(to: 0...max(outputHeight - 1, 0))
    let bottom = Int(max(y1, y2).clamped(to: 0...1) * Double(outputHeight))
      .clamped(to: min(top + 1, outputHeight)...outputHeight)
    var values: [Float] = []
    for y in top..<bottom {
      for x in left..<right {
        let index = y * outputWidth + x
        if index < map.count { values.append(map[index]) }
      }
    }
    guard !values.isEmpty else { return 0 }
    values.sort(by: >)
    let count = max(1, values.count / 4)
    let sum = values.prefix(count).reduce(0, +)
    return Double((sum / Float(count)).clamped(to: 0...1))
  }
}
