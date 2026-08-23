import Foundation
import onnxruntime_objc

struct MaculusWakeDetection {
  let name: String
  let confidence: Float
}

final class MaculusWakeWordEngine {
  private let melSession: ORTSession
  private let embeddingSession: ORTSession
  private let classifierSession: ORTSession
  private let threshold: Float

  private let embeddingWindow = 76
  private let embeddingStride = 8
  private let classifierEmbeddings = 16
  private let embeddingDimension = 96
  private let melBins = 32
  private let minimumSamples = 16_000
  private let maximumSamples = 48_000

  init(threshold: Float = 0.5) throws {
    self.threshold = threshold
    melSession = try MaculusORT.makeSession(resource: "melspectrogram")
    embeddingSession = try MaculusORT.makeSession(resource: "embedding_model")
    classifierSession = try MaculusORT.makeSession(resource: "hey_livekit")
  }

  func predict(samples: [Float]) throws -> MaculusWakeDetection? {
    guard samples.count >= minimumSamples else { return nil }
    let audio = Array(samples.suffix(maximumSamples))
    let melOutput = try MaculusORT.runFloat(
      session: melSession,
      values: audio,
      shape: [1, audio.count]
    )
    guard melOutput.shape.count >= 3 else { return nil }
    let frameCount = melOutput.shape[melOutput.shape.count - 2]
    guard frameCount >= embeddingWindow else { return nil }

    let mel = melOutput.values.map { $0 * 0.1 + 2 }
    let windowCount = (frameCount - embeddingWindow) / embeddingStride + 1
    guard windowCount >= classifierEmbeddings else { return nil }
    let startWindow = windowCount - classifierEmbeddings
    let elementsPerWindow = embeddingWindow * melBins
    var batch = [Float](repeating: 0, count: classifierEmbeddings * elementsPerWindow)
    for index in 0..<classifierEmbeddings {
      let sourceOffset = (startWindow + index) * embeddingStride * melBins
      let destinationOffset = index * elementsPerWindow
      guard sourceOffset + elementsPerWindow <= mel.count else { return nil }
      batch.replaceSubrange(
        destinationOffset..<(destinationOffset + elementsPerWindow),
        with: mel[sourceOffset..<(sourceOffset + elementsPerWindow)]
      )
    }
    let embeddings = try MaculusORT.runFloat(
      session: embeddingSession,
      values: batch,
      shape: [classifierEmbeddings, embeddingWindow, melBins, 1]
    ).values
    guard embeddings.count >= classifierEmbeddings * embeddingDimension else { return nil }
    let classifierInput = Array(embeddings.prefix(classifierEmbeddings * embeddingDimension))
    let score = try MaculusORT.runFloat(
      session: classifierSession,
      values: classifierInput,
      shape: [1, classifierEmbeddings, embeddingDimension]
    ).values.first ?? 0
    return score >= threshold
      ? MaculusWakeDetection(name: "hey_livekit", confidence: score)
      : nil
  }
}
