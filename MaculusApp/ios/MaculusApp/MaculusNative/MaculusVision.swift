import Foundation
import React

@objc(MaculusVision)
final class MaculusVision: NSObject {
  private let queue = DispatchQueue(label: "com.maculus.vision", qos: .userInitiated)
  private var interpreter: MaculusTFLiteRunner?
  private var labels: [String] = []
  private let inputSize = 320
  private let classCount = 80
  private let confidenceThreshold: Float = 0.30
  private let iouThreshold: Float = 0.45

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func loadModel(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      do {
        if self.interpreter != nil {
          resolve(["backend": "TensorFlow Lite CPU", "alreadyLoaded": true])
          return
        }
        let interpreter = try MaculusTFLiteRunner(
          modelPath: MaculusResources.path("yolo11s", extension: "tflite")
        )
        let input = interpreter.inputInfo
        let output = interpreter.outputInfo
        let inputShape = input.shape.map(\.intValue)
        guard inputShape == [1, self.inputSize, self.inputSize, 3] else {
          throw MaculusNativeError.message(
            "Expected YOLO input [1,320,320,3], got \(inputShape)"
          )
        }
        let shape = output.shape.map(\.intValue)
        guard shape.count == 3, shape[0] == 1, shape[1] == self.classCount + 4 else {
          throw MaculusNativeError.message(
            "Expected YOLO output [1,84,anchors], got \(shape)"
          )
        }
        self.labels = MaculusResources.textLines("coco-labels", extension: "txt")
        if self.labels.isEmpty { self.labels = Self.fallbackLabels }
        self.interpreter = interpreter
        resolve([
          "backend": "TensorFlow Lite CPU",
          "inputSize": self.inputSize,
          "numAnchors": shape[2],
          "quantized": output.dataTypeName != "float32",
        ])
      } catch {
        reject("MODEL_LOAD_ERROR", error.localizedDescription, error)
      }
    }
  }

  @objc func detect(
    _ base64Jpeg: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async {
      do {
        guard let interpreter = self.interpreter else {
          throw MaculusNativeError.message("Model not loaded. Call loadModel() first.")
        }
        let image = try MaculusImage.decode(base64: base64Jpeg)
        let letterbox = MaculusImage.letterbox(image, size: self.inputSize)
        let rgb = try MaculusImage.rgbBytes(letterbox.image)
        let outputData = try interpreter.invoke(
          inputData: self.inputData(rgb: rgb, tensor: interpreter.inputInfo)
        )
        let values = try self.outputValues(
          data: outputData,
          tensor: interpreter.outputInfo
        )
        let anchors = interpreter.outputInfo.shape[2].intValue
        let decoded = self.decode(values: values, anchors: anchors, letterbox: letterbox)
        let results = self.nonMaximumSuppression(decoded).map { detection in
          [
            "label": detection.classId < self.labels.count
              ? self.labels[detection.classId]
              : "object",
            "score": detection.score,
            "cx": detection.cx,
            "cy": detection.cy,
            "w": detection.w,
            "h": detection.h,
            "x1": detection.x1,
            "y1": detection.y1,
            "x2": detection.x2,
            "y2": detection.y2,
          ] as [String: Any]
        }
        resolve(results)
      } catch {
        reject("DETECT_ERROR", error.localizedDescription, error)
      }
    }
  }

  private func inputData(rgb: [UInt8], tensor: MaculusTFLiteTensorInfo) throws -> Data {
    switch tensor.dataTypeName {
    case "uint8":
      let scale = tensor.scale == 0 ? (1 / 255) : tensor.scale
      let zeroPoint = Int(tensor.zeroPoint)
      return Data(rgb.map { value in
        let normalized = Float(value) / 255
        return UInt8(clamping: Int(round(normalized / scale)) + zeroPoint)
      })
    case "int8":
      let scale = tensor.scale == 0 ? (1 / 255) : tensor.scale
      let zeroPoint = Int(tensor.zeroPoint)
      return Data(rgb.map { value in
        let normalized = Float(value) / 255
        let quantized = Int(round(normalized / scale)) + zeroPoint
        return UInt8(bitPattern: Int8(clamping: quantized))
      })
    case "float32":
      let values = rgb.map { Float32($0) / 255 }
      return values.withUnsafeBufferPointer { Data(buffer: $0) }
    default:
      throw MaculusNativeError.message("Unsupported YOLO input type: \(tensor.dataTypeName)")
    }
  }

  private func outputValues(
    data: Data,
    tensor: MaculusTFLiteTensorInfo
  ) throws -> [Float] {
    let scale = tensor.scale == 0 ? 1 : tensor.scale
    let zeroPoint = tensor.zeroPoint
    switch tensor.dataTypeName {
    case "uint8":
      return [UInt8](data).map { (Float($0) - Float(zeroPoint)) * scale }
    case "int8":
      return data.withUnsafeBytes { bytes in
        Array(bytes.bindMemory(to: Int8.self)).map {
          (Float($0) - Float(zeroPoint)) * scale
        }
      }
    case "float32":
      return data.withUnsafeBytes { bytes in
        Array(bytes.bindMemory(to: Float32.self)).map { value in Float(value) }
      }
    default:
      throw MaculusNativeError.message("Unsupported YOLO output type: \(tensor.dataTypeName)")
    }
  }

  private struct Detection {
    let cx: Float
    let cy: Float
    let w: Float
    let h: Float
    let score: Float
    let classId: Int
    let x1: Float
    let y1: Float
    let x2: Float
    let y2: Float
  }

  private func decode(
    values: [Float],
    anchors: Int,
    letterbox: MaculusLetterbox
  ) -> [Detection] {
    guard values.count >= (classCount + 4) * anchors else { return [] }
    var detections: [Detection] = []
    for anchor in 0..<anchors {
      var bestScore: Float = 0
      var bestClass = -1
      for classId in 0..<classCount {
        let score = values[(4 + classId) * anchors + anchor]
        if score > bestScore {
          bestScore = score
          bestClass = classId
        }
      }
      guard bestScore >= confidenceThreshold, bestClass >= 0 else { continue }
      let rawCx = values[anchor]
      let rawCy = values[anchors + anchor]
      let rawW = values[2 * anchors + anchor]
      let rawH = values[3 * anchors + anchor]
      let normalized = [abs(rawCx), abs(rawCy), abs(rawW), abs(rawH)].max()! <= 2
      let multiplier = normalized ? Float(inputSize) : 1
      let modelCx = rawCx * multiplier
      let modelCy = rawCy * multiplier
      let modelW = rawW * multiplier
      let modelH = rawH * multiplier
      let scale = Float(letterbox.scale)
      let sourceWidth = Float(letterbox.sourceWidth)
      let sourceHeight = Float(letterbox.sourceHeight)
      let cx = ((modelCx - Float(letterbox.padX)) / scale / sourceWidth).clamped(to: 0...1)
      let cy = ((modelCy - Float(letterbox.padY)) / scale / sourceHeight).clamped(to: 0...1)
      let width = (modelW / scale / sourceWidth).clamped(to: 0...1)
      let height = (modelH / scale / sourceHeight).clamped(to: 0...1)
      let x1 = (cx - width / 2).clamped(to: 0...1)
      let y1 = (cy - height / 2).clamped(to: 0...1)
      let x2 = (cx + width / 2).clamped(to: 0...1)
      let y2 = (cy + height / 2).clamped(to: 0...1)
      guard x2 > x1, y2 > y1 else { continue }
      detections.append(Detection(
        cx: (x1 + x2) / 2,
        cy: (y1 + y2) / 2,
        w: x2 - x1,
        h: y2 - y1,
        score: bestScore,
        classId: bestClass,
        x1: x1,
        y1: y1,
        x2: x2,
        y2: y2
      ))
    }
    return detections
  }

  private func nonMaximumSuppression(_ detections: [Detection]) -> [Detection] {
    let sorted = detections.sorted { $0.score > $1.score }
    var kept: [Detection] = []
    for detection in sorted {
      if kept.contains(where: {
        $0.classId == detection.classId && intersectionOverUnion($0, detection) > iouThreshold
      }) {
        continue
      }
      kept.append(detection)
    }
    return kept
  }

  private func intersectionOverUnion(_ first: Detection, _ second: Detection) -> Float {
    let intersectionWidth = max(0, min(first.x2, second.x2) - max(first.x1, second.x1))
    let intersectionHeight = max(0, min(first.y2, second.y2) - max(first.y1, second.y1))
    let intersection = intersectionWidth * intersectionHeight
    let firstArea = (first.x2 - first.x1) * (first.y2 - first.y1)
    let secondArea = (second.x2 - second.x1) * (second.y2 - second.y1)
    let union = firstArea + secondArea - intersection
    return union > 0 ? intersection / union : 0
  }

  private static let fallbackLabels = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli",
    "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant",
    "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
    "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book",
    "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
  ]
}
