import Foundation
import React
import UIKit

@objc(MaculusKeepAwake)
final class MaculusKeepAwake: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func setEnabled(
    _ enabled: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = enabled
      resolve(nil)
    }
  }
}
