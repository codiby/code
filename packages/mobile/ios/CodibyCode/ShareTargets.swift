import Foundation
import React

@objc(ShareTargets)
class ShareTargets: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(cacheSessions:resolver:rejecter:)
  func cacheSessions(_ snapshot: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    do {
      try ShareConfig.writeSessions(Data(snapshot.utf8))
      resolve(nil)
    } catch { reject("SHARE_SESSIONS", "No se pudo guardar la lista de chats", error) }
  }

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
