//
// Maculus integration for Apple's FastVLM research model.
// Apple FastVLM source and model terms are tracked in src/models.
//

import CoreImage
import Foundation
import MLX
import MLXLMCommon
import MLXRandom
import MLXVLM

public struct MaculusFastVLMResult: Sendable {
    public let text: String
    public let timeToFirstTokenMs: Int
    public let totalTimeMs: Int

    public init(text: String, timeToFirstTokenMs: Int, totalTimeMs: Int) {
        self.text = text
        self.timeToFirstTokenMs = timeToFirstTokenMs
        self.totalTimeMs = totalTimeMs
    }
}

/// Keeps the model loaded for a guidance session and performs one deterministic
/// visual turn at a time. The caller owns the surrounding Task; cancelling that
/// Task is observed from FastVLM's token callback and stops generation promptly.
public actor MaculusFastVLMEngine {
    public static let shared = MaculusFastVLMEngine()
    public static let modelName = "Apple FastVLM-1.5B INT8"

    private let configuration = FastVLM.modelConfiguration
    private let parameters = GenerateParameters(temperature: 0.0)
    private var container: ModelContainer?

    public init() {
        FastVLM.register(modelFactory: VLMModelFactory.shared)
        // Apple uses this small cache in the reference app. It avoids letting
        // transient Metal buffers compete with Maculus camera and detector work.
        MLX.GPU.set(cacheLimit: 20 * 1024 * 1024)
    }

    public func load() async throws {
        _ = try await loadedContainer()
    }

    public func generate(
        jpegData: Data?,
        prompt: String,
        maxTokens requestedMaxTokens: Int
    ) async throws -> MaculusFastVLMResult {
        let modelContainer = try await loadedContainer()
        try Task.checkCancellation()

        let userInput: UserInput
        if let jpegData {
            guard let image = CIImage(
                data: jpegData,
                options: [.applyOrientationProperty: true]
            ) else {
                throw MaculusFastVLMError.invalidImage
            }
            userInput = UserInput(
                prompt: .text(prompt),
                images: [.ciImage(Self.squareLetterboxed(image))]
            )
        } else {
            userInput = UserInput(prompt: .text(prompt), images: [])
        }
        let maxTokens = min(max(requestedMaxTokens, 16), 128)
        let startedAt = Date()

        let generated = try await modelContainer.perform { context in
            try Task.checkCancellation()
            let input = try await context.processor.prepare(input: userInput)
            try Task.checkCancellation()

            var firstTokenAt: Date?
            MLXRandom.seed(UInt64(Date.timeIntervalSinceReferenceDate * 1_000))
            let result = try MLXLMCommon.generate(
                input: input,
                parameters: parameters,
                context: context
            ) { tokens in
                if Task.isCancelled {
                    return .stop
                }
                if firstTokenAt == nil, !tokens.isEmpty {
                    firstTokenAt = Date()
                }
                return tokens.count >= maxTokens ? .stop : .more
            }
            return (result.output, firstTokenAt)
        }

        try Task.checkCancellation()
        let finishedAt = Date()
        return MaculusFastVLMResult(
            text: generated.0.trimmingCharacters(in: .whitespacesAndNewlines),
            timeToFirstTokenMs: Int(
                (generated.1 ?? finishedAt).timeIntervalSince(startedAt) * 1_000
            ),
            totalTimeMs: Int(finishedAt.timeIntervalSince(startedAt) * 1_000)
        )
    }

    public func release() {
        container = nil
    }

    private func loadedContainer() async throws -> ModelContainer {
        if let container {
            return container
        }
        let loaded = try await VLMModelFactory.shared.loadContainer(
            configuration: configuration
        ) { _ in }
        container = loaded
        return loaded
    }

    /// FastVLM's reference preprocessor center-crops to a square. Letterboxing
    /// first preserves the phone camera's left and right edges, which matter for
    /// a blind user's scene description.
    private static func squareLetterboxed(_ image: CIImage) -> CIImage {
        let extent = image.extent.integral
        let side = max(extent.width, extent.height)
        let canvas = CGRect(x: 0, y: 0, width: side, height: side)
        let x = (side - extent.width) / 2 - extent.minX
        let y = (side - extent.height) / 2 - extent.minY
        let foreground = image.transformed(
            by: CGAffineTransform(translationX: x, y: y)
        )
        let background = CIImage(
            color: CIColor(red: 0, green: 0, blue: 0, alpha: 1)
        ).cropped(to: canvas)
        return foreground.composited(over: background).cropped(to: canvas)
    }
}

public enum MaculusFastVLMError: LocalizedError {
    case invalidImage

    public var errorDescription: String? {
        switch self {
        case .invalidImage:
            return "FastVLM could not decode the camera frame."
        }
    }
}
