import AVFoundation
import Foundation
import React

@objc(MaculusSoundCue)
final class MaculusSoundCue: NSObject, AVAudioPlayerDelegate {
  private var activationPlayer: AVAudioPlayer?
  private var activationResolve: RCTPromiseResolveBlock?
  private var processingPlayer: AVAudioPlayer?

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func playActivation(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      self.stopActivation(resolvePending: true)
      do {
        let player = try AVAudioPlayer(contentsOf: try self.soundURL(named: "activation_sound"))
        player.delegate = self
        player.volume = 1
        player.prepareToPlay()
        self.activationPlayer = player
        self.activationResolve = resolve
        guard player.play() else {
          throw MaculusNativeError.message("Activation sound could not start")
        }
      } catch {
        self.activationPlayer = nil
        self.activationResolve = nil
        reject("ACTIVATION_SOUND_ERROR", error.localizedDescription, error)
      }
    }
  }

  @objc func startProcessing(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      if self.processingPlayer?.isPlaying == true {
        resolve(nil)
        return
      }
      self.stopProcessingPlayer()
      do {
        let player = try AVAudioPlayer(contentsOf: try self.soundURL(named: "processing_sound"))
        player.numberOfLoops = -1
        player.volume = 1
        player.prepareToPlay()
        guard player.play() else {
          throw MaculusNativeError.message("Processing sound could not start")
        }
        self.processingPlayer = player
        resolve(nil)
      } catch {
        self.stopProcessingPlayer()
        reject("PROCESSING_SOUND_ERROR", error.localizedDescription, error)
      }
    }
  }

  @objc func stopProcessing(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      self.stopProcessingPlayer()
      resolve(nil)
    }
  }

  @objc func stopAll(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      self.stopActivation(resolvePending: true)
      self.stopProcessingPlayer()
      resolve(nil)
    }
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
    if player === activationPlayer { stopActivation(resolvePending: true) }
  }

  private func soundURL(named name: String) throws -> URL {
    if let url = Bundle.main.url(forResource: name, withExtension: "mp3") { return url }
    if let url = Bundle(for: MaculusSoundCue.self).url(forResource: name, withExtension: "mp3") { return url }
    throw MaculusNativeError.message("Bundled sound \(name).mp3 is missing")
  }

  private func stopActivation(resolvePending: Bool) {
    activationPlayer?.stop()
    activationPlayer = nil
    if resolvePending { activationResolve?(nil) }
    activationResolve = nil
  }

  private func stopProcessingPlayer() {
    processingPlayer?.stop()
    processingPlayer = nil
  }
}
