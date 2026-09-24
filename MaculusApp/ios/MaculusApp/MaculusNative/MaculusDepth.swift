import Foundation
import React
import UIKit
import onnxruntime_objc

private struct MaculusDepthImageLayout {
  let image: UIImage
  /** Visible source image inside the model's normalized output canvas. */
  let contentRect: CGRect
  let gridWidth: Int
  let gridHeight: Int
}

@objc(MaculusDepth)
final class MaculusDepth: NSObject {
  // Route depth is latency-sensitive. A serial user-initiated queue prevents
  // overlapping inferences while allowing iOS to prioritize the newest frame.
  private let queue = DispatchQueue(label: "com.maculus.depth", qos: .userInitiated, autoreleaseFrequency: .workItem)
  private var session: ORTSession?
  private var metric = false
  private var modelName = "Depth Anything V2 Small (relative fallback)"
  private let inputSize = 256
  private var outputWidth = 518
  private var outputHeight = 518

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func loadDepthModel(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    load(resolve: resolve, reject: reject)
  }

  private func load(resolve: @escaping RCTPromiseResolveBlock,
                    reject: @escaping RCTPromiseRejectBlock) {
    queue.async {
      do {
        let alreadyLoaded = self.session != nil
        if self.session == nil {
          if (try? MaculusResources.path("depth_metric_indoor_uint8_256", extension: "onnx")) != nil {
            self.session = try MaculusORT.makeSession(resource: "depth_metric_indoor_uint8_256")
            self.metric = true
            self.modelName = "Depth Anything V2 Metric Indoor Small"
            self.outputWidth = 64
            self.outputHeight = 48
          } else {
            self.session = try MaculusORT.makeSession(resource: "depth_anything_v2_small_uint8_256")
            self.metric = false
            self.modelName = "Depth Anything V2 Small (relative fallback)"
          }
        }
        resolve([
          "backend": "ONNX Runtime iOS",
          "inputSize": self.inputSize,
          "outputWidth": self.outputWidth,
          "outputHeight": self.outputHeight,
          "available": true,
          "alreadyLoaded": alreadyLoaded,
          "units": self.metric ? "metres" : "relative-nearness",
          "modelName": self.modelName,
          "domain": self.metric ? "indoor" : "general",
        ])
      } catch {
        reject("DEPTH_MODEL_LOAD_ERROR", error.localizedDescription, error)
      }
    }
  }

  @objc func unloadDepthModel(_ resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
    queue.async {
      self.session = nil
      resolve(true)
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
        let startedAt = CFAbsoluteTimeGetCurrent()
        guard let session = self.session else {
          throw MaculusNativeError.message("Depth model is not loaded")
        }
        let image = try MaculusImage.decode(base64: base64Jpeg)
        let layout = self.prepareModelInput(image)
        let rgb = try MaculusImage.rgbBytes(layout.image)
        let output = try MaculusORT.runUInt8(
          session: session,
          values: rgb,
          shape: [1, self.inputSize, self.inputSize, 3]
        )
        self.updateOutputDimensions(shape: output.shape, count: output.values.count)
        let depthMap = output.values.map { value in
          value.isFinite && value > 0 ? value : (self.metric ? 20 : 0)
        }
        let rawNearMap = self.metric
          ? depthMap.map { self.metricNearScore($0) }
          : try self.normalize(depthMap)
        // Return a grid in the source frame's own orientation. Portrait phone
        // frames are fitted into the fixed landscape metric graph and cropped
        // back out here, so detector boxes and depth cells share coordinates.
        let sourceDepthMap = self.remapToSource(
          depthMap,
          layout: layout,
          mapWidth: self.outputWidth,
          mapHeight: self.outputHeight
        )
        let sourceNearMap = self.remapToSource(
          rawNearMap,
          layout: layout,
          mapWidth: self.outputWidth,
          mapHeight: self.outputHeight
        )
        let objectDepths = detections.enumerated().map { index, detection in
          let cx = detection.maculusDouble("cx", fallback: 0.5)
          let cy = detection.maculusDouble("cy", fallback: 0.5)
          let width = detection.maculusDouble("w", fallback: 0)
          let height = detection.maculusDouble("h", fallback: 0)
          let x1 = detection.maculusDouble("x1", fallback: cx - width / 2)
          let y1 = detection.maculusDouble("y1", fallback: cy - height / 2)
          let x2 = detection.maculusDouble("x2", fallback: cx + width / 2)
          let y2 = detection.maculusDouble("y2", fallback: cy + height / 2)
          let innerX1 = x1 + (x2 - x1) * 0.22
          let innerY1 = self.metric ? y1 + (y2 - y1) * 0.55 : y1 + (y2 - y1) * 0.22
          let innerX2 = x2 - (x2 - x1) * 0.22
          let innerY2 = self.metric ? y1 + (y2 - y1) * 0.9 : y2 - (y2 - y1) * 0.22
          var item = [
            "index": index,
            "nearScore": self.sample(
              map: sourceNearMap,
              width: layout.gridWidth,
              height: layout.gridHeight,
              x1: innerX1,
              y1: innerY1,
              x2: innerX2,
              y2: innerY2
            ),
          ] as [String: Any]
          if self.metric, let distance = self.sampleDistance(
            map: sourceDepthMap,
            width: layout.gridWidth,
            height: layout.gridHeight,
            x1: innerX1,
            y1: innerY1,
            x2: innerX2,
            y2: innerY2
          ) {
            item["distanceMetres"] = distance
            item["confidence"] = 0.45
          }
          return item
        }
        let gridWidth = layout.gridWidth
        let gridHeight = layout.gridHeight
        let compactMap = self.metric ? sourceDepthMap : sourceNearMap
        let grid = compactMap.map { value in value.isFinite ? Double(value) : 0 }
        resolve([
          "grid": [
            "width": gridWidth, "height": gridHeight, "values": grid,
            "units": self.metric ? "metres" : "relative-nearness"
          ],
          "width": gridWidth,
          "height": gridHeight,
          "leftNearScore": self.sample(map: sourceNearMap, width: gridWidth, height: gridHeight,
            x1: 0, y1: 0, x2: 1.0 / 3.0, y2: 1),
          "centerNearScore": self.sample(map: sourceNearMap, width: gridWidth, height: gridHeight,
            x1: 1.0 / 3.0, y1: 0, x2: 2.0 / 3.0, y2: 1),
          "rightNearScore": self.sample(map: sourceNearMap, width: gridWidth, height: gridHeight,
            x1: 2.0 / 3.0, y1: 0, x2: 1, y2: 1),
          "objectDepths": objectDepths,
          "units": self.metric ? "metres" : "relative-nearness",
          "modelName": self.modelName,
          "domain": self.metric ? "indoor" : "general",
          "inferenceMs": (CFAbsoluteTimeGetCurrent() - startedAt) * 1000,
        ])
      } catch {
        reject("DEPTH_ESTIMATE_ERROR", error.localizedDescription, error)
      }
    }
  }

  private func prepareModelInput(_ image: UIImage) -> MaculusDepthImageLayout {
    let sourceWidth = CGFloat(image.cgImage?.width ?? Int(image.size.width))
    let sourceHeight = CGFloat(image.cgImage?.height ?? Int(image.size.height))
    let sourceAspect = max(0.01, sourceWidth / max(1, sourceHeight))
    // The current metric graph was exported on a 4:3 tensor. Preserve an
    // arbitrary source frame inside that canvas instead of stretching a
    // portrait iPhone image to landscape.
    let canvasAspect: CGFloat = metric ? 4.0 / 3.0 : 1
    let contentRect: CGRect
    if sourceAspect >= canvasAspect {
      let height = canvasAspect / sourceAspect
      contentRect = CGRect(x: 0, y: (1 - height) / 2, width: 1, height: height)
    } else {
      let width = sourceAspect / canvasAspect
      contentRect = CGRect(x: (1 - width) / 2, y: 0, width: width, height: 1)
    }

    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    let square = UIGraphicsImageRenderer(
      size: CGSize(width: inputSize, height: inputSize),
      format: format
    ).image { context in
      // ImageNet mean becomes approximately zero after normalization and
      // avoids adding a high-contrast artificial black border.
      UIColor(red: 0.485, green: 0.456, blue: 0.406, alpha: 1).setFill()
      context.cgContext.fill(CGRect(x: 0, y: 0, width: inputSize, height: inputSize))
      image.draw(in: CGRect(
        x: contentRect.minX * CGFloat(inputSize),
        y: contentRect.minY * CGFloat(inputSize),
        width: contentRect.width * CGFloat(inputSize),
        height: contentRect.height * CGFloat(inputSize)
      ))
    }
    let longestGridEdge = 64
    let gridWidth: Int
    let gridHeight: Int
    if sourceAspect >= 1 {
      gridWidth = longestGridEdge
      gridHeight = max(12, Int((CGFloat(longestGridEdge) / sourceAspect).rounded()))
    } else {
      gridHeight = longestGridEdge
      gridWidth = max(12, Int((CGFloat(longestGridEdge) * sourceAspect).rounded()))
    }
    return MaculusDepthImageLayout(
      image: square,
      contentRect: contentRect,
      gridWidth: gridWidth,
      gridHeight: gridHeight
    )
  }

  private func remapToSource(
    _ map: [Float],
    layout: MaculusDepthImageLayout,
    mapWidth: Int,
    mapHeight: Int
  ) -> [Float] {
    guard mapWidth > 0, mapHeight > 0, map.count >= mapWidth * mapHeight else {
      return [Float](repeating: 0, count: layout.gridWidth * layout.gridHeight)
    }
    return (0..<(layout.gridWidth * layout.gridHeight)).map { index in
      let gridX = index % layout.gridWidth
      let gridY = index / layout.gridWidth
      let sourceU = (CGFloat(gridX) + 0.5) / CGFloat(layout.gridWidth)
      let sourceV = (CGFloat(gridY) + 0.5) / CGFloat(layout.gridHeight)
      let modelU = layout.contentRect.minX + sourceU * layout.contentRect.width
      let modelV = layout.contentRect.minY + sourceV * layout.contentRect.height
      let x = Int((modelU * CGFloat(mapWidth)).rounded(.down)).clamped(to: 0...(mapWidth - 1))
      let y = Int((modelV * CGFloat(mapHeight)).rounded(.down)).clamped(to: 0...(mapHeight - 1))
      return map[y * mapWidth + x]
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
    guard let absoluteMinimum = finite.min(), let absoluteMaximum = finite.max() else {
      throw MaculusNativeError.message("Depth model returned no finite values")
    }
    // A few extreme pixels should not rescale the complete scene from frame to
    // frame. Estimate robust 2nd/98th percentiles from a bounded sample.
    let stride = max(1, finite.count / 4096)
    let sample = Swift.stride(from: 0, to: finite.count, by: stride).map { finite[$0] }.sorted()
    let minimum = sample.isEmpty ? absoluteMinimum : sample[Int(Double(sample.count - 1) * 0.02)]
    let maximum = sample.isEmpty ? absoluteMaximum : sample[Int(Double(sample.count - 1) * 0.98)]
    let range = max(0.000001, maximum - minimum)
    let count = outputWidth * outputHeight
    return (0..<count).map { index in
      let value = index < raw.count && raw[index].isFinite ? raw[index] : minimum
      return ((value - minimum) / range).clamped(to: 0...1)
    }
  }

  private func sample(
    map: [Float],
    width: Int,
    height: Int,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double
  ) -> Double {
    let left = Int(min(x1, x2).clamped(to: 0...1) * Double(width))
      .clamped(to: 0...max(width - 1, 0))
    let right = Int(max(x1, x2).clamped(to: 0...1) * Double(width))
      .clamped(to: min(left + 1, width)...width)
    let top = Int(min(y1, y2).clamped(to: 0...1) * Double(height))
      .clamped(to: 0...max(height - 1, 0))
    let bottom = Int(max(y1, y2).clamped(to: 0...1) * Double(height))
      .clamped(to: min(top + 1, height)...height)
    var values: [Float] = []
    for y in top..<bottom {
      for x in left..<right {
        let index = y * width + x
        if index < map.count { values.append(map[index]) }
      }
    }
    guard !values.isEmpty else { return 0 }
    values.sort(by: >)
    let count = max(1, values.count / 4)
    let sum = values.prefix(count).reduce(0, +)
    return Double((sum / Float(count)).clamped(to: 0...1))
  }

  private func sampleDistance(
    map: [Float],
    width: Int,
    height: Int,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double
  ) -> Double? {
    let left = Int(min(x1, x2).clamped(to: 0...1) * Double(width))
      .clamped(to: 0...max(width - 1, 0))
    let right = Int(max(x1, x2).clamped(to: 0...1) * Double(width))
      .clamped(to: min(left + 1, width)...width)
    let top = Int(min(y1, y2).clamped(to: 0...1) * Double(height))
      .clamped(to: 0...max(height - 1, 0))
    let bottom = Int(max(y1, y2).clamped(to: 0...1) * Double(height))
      .clamped(to: min(top + 1, height)...height)
    var values: [Float] = []
    for y in top..<bottom {
      for x in left..<right {
        let index = y * width + x
        if index < map.count, map[index].isFinite, map[index] >= 0.15, map[index] <= 20 {
          values.append(map[index])
        }
      }
    }
    guard !values.isEmpty else { return nil }
    values.sort()
    return Double(values[Int(Double(values.count - 1) * 0.4)])
  }

  private func metricNearScore(_ distance: Float) -> Float {
    guard distance.isFinite, distance >= 0.15, distance <= 20 else { return 0 }
    return ((4 - distance) / 3.65).clamped(to: 0...1)
  }
}
