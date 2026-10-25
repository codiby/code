import UIKit
import UniformTypeIdentifiers
import ImageIO
import React
import React_RCTAppDelegate

/** La extensión solo prepara adjuntos y hospeda la misma pantalla React Native. */
class ShareViewController: UIViewController, ShareReceiving {
  private var reactDelegate: ShareReactDelegate?
  private var factory: RCTReactNativeFactory?
  private let requestId = UUID().uuidString
  private var preparation: Task<[String: Any], Error>?

  override func viewDidLoad() {
    super.viewDidLoad()
    ShareTargets.receiver = self
    ShareTargets.requestId = requestId
    let delegate = ShareReactDelegate()
    delegate.dependencyProvider = ShareDependencyProvider()
    let factory = RCTReactNativeFactory(delegate: delegate)
    self.reactDelegate = delegate; self.factory = factory
    let root = factory.rootViewFactory.view(withModuleName: "CodibyShare", initialProperties: ["requestId": requestId], launchOptions: nil)
    view.addSubview(root)
    root.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      root.topAnchor.constraint(equalTo: view.topAnchor), root.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      root.leadingAnchor.constraint(equalTo: view.leadingAnchor), root.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
  }

  func readShared(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    if preparation == nil {
      let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
      preparation = Task {
        let providers = items.flatMap { $0.attachments ?? [] }.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        guard (1...4).contains(providers.count) else { throw ShareError.message("Comparte entre 1 y 4 imágenes.") }
        var images: [[String: String]] = []
        for provider in providers { images.append(try await Self.loadImage(provider)) }
        let config = try ShareConfig.readData()
        return ["config": String(decoding: config, as: UTF8.self),
          "snapshot": String(decoding: ShareConfig.sessionsData() ?? Data("[]".utf8), as: UTF8.self),
          "images": images,
          "text": String(items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n").prefix(8000))]
      }
    }
    Task {
      do { resolve(try await preparation!.value) }
      catch { reject("SHARE_IMAGES", error.localizedDescription, error) }
    }
  }

  func finishShared(sent: Bool) {
    if sent { extensionContext?.completeRequest(returningItems: nil) }
    else { extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }
  }

  nonisolated private static func image(_ source: CGImageSource) throws -> [String: String] {
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 1920,
      kCGImageSourceShouldCacheImmediately: true]
    guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      throw ShareError.message("Imagen inválida")
    }
    let original = UIImage(cgImage: cgImage)
    let image: UIImage
    switch cgImage.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast: image = original
    default:
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1; format.opaque = true
      let size = CGSize(width: CGFloat(cgImage.width), height: CGFloat(cgImage.height))
      image = UIGraphicsImageRenderer(size: size, format: format).image { context in
        UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
        original.draw(in: CGRect(origin: .zero, size: size))
      }
    }
    guard let data = image.jpegData(compressionQuality: 0.8), data.count <= 2_250_000 else {
      throw ShareError.message("Imagen demasiado grande")
    }
    return ["mediaType": "image/jpeg", "data": data.base64EncodedString()]
  }

  nonisolated private static func loadImage(_ provider: NSItemProvider) async throws -> [String: String] {
    let type = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true }
      ?? UTType.image.identifier
    let fromFile: [String: String]? = try await withCheckedThrowingContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
        guard let url, let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else {
          continuation.resume(returning: nil); return
        }
        do { continuation.resume(returning: try image(source)) } catch { continuation.resume(throwing: error) }
      }
    }
    if let fromFile { return fromFile }
    return try await withCheckedThrowingContinuation { continuation in
      provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
        guard let data, data.count <= 40_000_000,
          let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else {
          continuation.resume(throwing: ShareError.message("Imagen no disponible")); return
        }
        do { continuation.resume(returning: try image(source)) } catch { continuation.resume(throwing: error) }
      }
    }
  }

}

private class ShareReactDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? { bundleURL() }
  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "share.index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
