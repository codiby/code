import Foundation
import React

@objc(ShareTargets)
class ShareTargets: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(configure:resolver:rejecter:)
  func configure(_ config: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    do {
      try ShareConfig.write(Data(config.utf8))
      resolve(nil)
    } catch {
      reject("SHARE_CONFIG", "No se pudo guardar la configuración para compartir", error)
    }
  }
}
