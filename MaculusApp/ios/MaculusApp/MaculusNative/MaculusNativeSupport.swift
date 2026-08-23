import Foundation
import UIKit
import onnxruntime_objc

enum MaculusNativeError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let message): return message
    }
  }
}

enum MaculusResources {
  static func path(_ name: String, extension ext: String) throws -> String {
    let bundles = [Bundle.main, Bundle(for: MaculusBundleToken.self)]
    for bundle in bundles {
      if let path = bundle.path(forResource: name, ofType: ext) {
        return path
      }
      if let path = bundle.path(forResource: name, ofType: ext, inDirectory: "wakeword") {
        return path
      }
    }
    throw MaculusNativeError.message("Missing bundled model: \(name).\(ext)")
  }

  static func textLines(_ name: String, extension ext: String) -> [String] {
    guard let path = try? path(name, extension: ext),
          let contents = try? String(contentsOfFile: path, encoding: .utf8) else {
      return []
    }
    return contents
      .split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }
}

private final class MaculusBundleToken: NSObject {}

struct MaculusORTOutput {
  let values: [Float]
  let shape: [Int]
}

enum MaculusORT {
  private static let environmentResult: Result<ORTEnv, Error> = Result {
    try ORTEnv(loggingLevel: .warning)
  }

  static func makeSession(resource: String, extension ext: String = "onnx") throws -> ORTSession {
    let environment = try environmentResult.get()
    let options = try ORTSessionOptions()
    try options.setIntraOpNumThreads(2)
    return try ORTSession(
      env: environment,
      modelPath: try MaculusResources.path(resource, extension: ext),
      sessionOptions: options
    )
  }

  static func runFloat(
    session: ORTSession,
    values: [Float],
    shape: [Int],
    inputName: String? = nil,
    outputName: String? = nil
  ) throws -> MaculusORTOutput {
    let data = values.withUnsafeBufferPointer { Data(buffer: $0) }
    return try run(
      session: session,
      data: data,
      elementType: .float,
      shape: shape,
      inputName: inputName,
      outputName: outputName
    )
  }

  static func runUInt8(
    session: ORTSession,
    values: [UInt8],
    shape: [Int],
    inputName: String? = nil,
    outputName: String? = nil
  ) throws -> MaculusORTOutput {
    try run(
      session: session,
      data: Data(values),
      elementType: .uInt8,
      shape: shape,
      inputName: inputName,
      outputName: outputName
    )
  }

  private static func run(
    session: ORTSession,
    data: Data,
    elementType: ORTTensorElementDataType,
    shape: [Int],
    inputName: String?,
    outputName: String?
  ) throws -> MaculusORTOutput {
    let availableInputs = try session.inputNames()
    let availableOutputs = try session.outputNames()
    guard let resolvedInput = inputName ?? availableInputs.first,
          let resolvedOutput = outputName ?? availableOutputs.first else {
      throw MaculusNativeError.message("ONNX model has no input or output tensor")
    }
    let tensor = try ORTValue(
      tensorData: NSMutableData(data: data),
      elementType: elementType,
      shape: shape.map { NSNumber(value: $0) }
    )
    let outputs = try session.run(
      withInputs: [resolvedInput: tensor],
      outputNames: [resolvedOutput],
      runOptions: nil
    )
    guard let output = outputs[resolvedOutput] else {
      throw MaculusNativeError.message("ONNX model did not return \(resolvedOutput)")
    }
    let info = try output.tensorTypeAndShapeInfo()
    let outputData = try output.tensorData() as Data
    let values: [Float]
    switch info.elementType {
    case .float:
      values = array(from: outputData, as: Float32.self).map { value in Float(value) }
    case .uInt8:
      values = [UInt8](outputData).map { value in Float(value) }
    case .int8:
      values = array(from: outputData, as: Int8.self).map { value in Float(value) }
    default:
      throw MaculusNativeError.message("Unsupported ONNX output tensor type: \(info.elementType.rawValue)")
    }
    return MaculusORTOutput(values: values, shape: info.shape.map(\.intValue))
  }

  private static func array<T>(from data: Data, as type: T.Type) -> [T] {
    guard data.count % MemoryLayout<T>.stride == 0 else { return [] }
    return data.withUnsafeBytes { Array($0.bindMemory(to: T.self)) }
  }
}

struct MaculusLetterbox {
  let image: UIImage
  let scale: CGFloat
  let padX: CGFloat
  let padY: CGFloat
  let sourceWidth: CGFloat
  let sourceHeight: CGFloat
}

enum MaculusImage {
  static func decode(base64: String) throws -> UIImage {
    guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
          !data.isEmpty,
          let image = UIImage(data: data) else {
      throw MaculusNativeError.message("Failed to decode JPEG image")
    }
    return normalized(image)
  }

  static func normalized(_ image: UIImage) -> UIImage {
    guard image.imageOrientation != .up else { return image }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }

  static func resized(_ image: UIImage, width: Int, height: Int) -> UIImage {
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    return UIGraphicsImageRenderer(
      size: CGSize(width: width, height: height),
      format: format
    ).image { _ in
      image.draw(in: CGRect(x: 0, y: 0, width: width, height: height))
    }
  }

  static func letterbox(_ image: UIImage, size: Int) -> MaculusLetterbox {
    // Use decoded pixels rather than UIImage points. They normally match for
    // our JPEGs, but camera images can carry a non-1 scale or orientation
    // metadata; model coordinates must be mapped to the actual pixel frame.
    let sourceWidth = CGFloat(image.cgImage?.width ?? Int(image.size.width))
    let sourceHeight = CGFloat(image.cgImage?.height ?? Int(image.size.height))
    let scale = min(CGFloat(size) / sourceWidth, CGFloat(size) / sourceHeight)
    let width = sourceWidth * scale
    let height = sourceHeight * scale
    let padX = (CGFloat(size) - width) / 2
    let padY = (CGFloat(size) - height) / 2
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    let canvas = UIGraphicsImageRenderer(
      size: CGSize(width: size, height: size),
      format: format
    ).image { context in
      UIColor(red: 114 / 255, green: 114 / 255, blue: 114 / 255, alpha: 1).setFill()
      context.cgContext.fill(CGRect(x: 0, y: 0, width: size, height: size))
      image.draw(in: CGRect(x: padX, y: padY, width: width, height: height))
    }
    return MaculusLetterbox(
      image: canvas,
      scale: scale,
      padX: padX,
      padY: padY,
      sourceWidth: sourceWidth,
      sourceHeight: sourceHeight
    )
  }

  static func cropped(_ image: UIImage, normalizedRect: CGRect) throws -> UIImage {
    guard let cgImage = image.cgImage else {
      throw MaculusNativeError.message("Image has no pixel buffer")
    }
    let width = CGFloat(cgImage.width)
    let height = CGFloat(cgImage.height)
    let rect = CGRect(
      x: normalizedRect.minX * width,
      y: normalizedRect.minY * height,
      width: normalizedRect.width * width,
      height: normalizedRect.height * height
    ).integral.intersection(CGRect(x: 0, y: 0, width: width, height: height))
    guard rect.width >= 1, rect.height >= 1,
          let cropped = cgImage.cropping(to: rect) else {
      throw MaculusNativeError.message("Person crop is empty")
    }
    return UIImage(cgImage: cropped, scale: 1, orientation: .up)
  }

  static func rgbBytes(_ image: UIImage) throws -> [UInt8] {
    guard let cgImage = image.cgImage else {
      throw MaculusNativeError.message("Image has no CGImage")
    }
    let width = cgImage.width
    let height = cgImage.height
    var rgba = [UInt8](repeating: 0, count: width * height * 4)
    let rendered = rgba.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue |
          CGBitmapInfo.byteOrder32Big.rawValue
      ) else { return false }
      context.interpolationQuality = .high
      context.translateBy(x: 0, y: CGFloat(height))
      context.scaleBy(x: 1, y: -1)
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard rendered else {
      throw MaculusNativeError.message("Failed to render image pixels")
    }
    var rgb = [UInt8](repeating: 0, count: width * height * 3)
    for pixel in 0..<(width * height) {
      rgb[pixel * 3] = rgba[pixel * 4]
      rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1]
      rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2]
    }
    return rgb
  }
}

extension Dictionary where Key == String, Value == Any {
  func maculusDouble(_ key: String, fallback: Double) -> Double {
    (self[key] as? NSNumber)?.doubleValue ?? fallback
  }
}

extension Comparable {
  func clamped(to limits: ClosedRange<Self>) -> Self {
    min(max(self, limits.lowerBound), limits.upperBound)
  }
}
