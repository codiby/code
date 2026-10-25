import Foundation
import React

protocol ShareReceiving: AnyObject {
  func readShared(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
  func finishShared(sent: Bool)
}

@objc(ShareTargets)
class ShareTargets: NSObject {
  static var requestId = ""
  static weak var receiver: ShareReceiving?

  @objc(read:resolver:rejecter:)
  func read(_ requestId: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard requestId == Self.requestId, let receiver = Self.receiver else { reject("SHARE_CONTEXT", "No hay imágenes compartidas", nil); return }
      receiver.readShared(resolve: resolve, reject: reject)
    }
  }

  @objc(finish:sent:resolver:rejecter:)
  func finish(_ requestId: String, sent: Bool, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async { if requestId == Self.requestId { Self.receiver?.finishShared(sent: sent) }; resolve(nil) }
  }

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
