import UIKit
import SwiftUI
import UniformTypeIdentifiers
import ImageIO

private struct PreparedShareImage: Identifiable {
  let id = UUID()
  let payload: SharedImagePayload
  let preview: UIImage
}

@MainActor
private final class ShareModel: ObservableObject {
  @Published var images: [PreparedShareImage] = []
  @Published var sessions: [ShareSession] = []
  @Published var selected: String?
  @Published var text = ""
  @Published var search = ""
  @Published var error: String?
  @Published var loading = true
  @Published var sending = false
  private let client = ShareClient()
  var complete: (() -> Void)?

  var filtered: [ShareSession] {
    sessions.filter { search.isEmpty || "\($0.name) \($0.folder) \($0.server.name)".localizedCaseInsensitiveContains(search) }
  }
  var canSend: Bool { !loading && !sending && !images.isEmpty && filtered.contains { $0.id == selected } }

  func prepare(_ items: [NSExtensionItem]) async {
    let providers = items.flatMap { $0.attachments ?? [] }.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
    guard !providers.isEmpty && providers.count <= 4 else { loading = false; error = "Comparte entre 1 y 4 imágenes."; return }
    text = String(items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n").prefix(8000))
    do {
      for provider in providers { images.append(try await Self.loadImage(provider)) }
      await loadSessions()
    } catch { loading = false; images = []; self.error = "No se pudo leer alguna imagen. Vuelve a compartirla desde Fotos." }
  }

  nonisolated private static func image(_ source: CGImageSource) throws -> PreparedShareImage {
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
    let size = CGSize(width: CGFloat(cgImage.width) / 8, height: CGFloat(cgImage.height) / 8)
    let previewFormat = UIGraphicsImageRendererFormat()
    previewFormat.scale = 1
    let preview = UIGraphicsImageRenderer(size: size, format: previewFormat).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    return PreparedShareImage(payload: SharedImagePayload(media_type: "image/jpeg", data: data.base64EncodedString()), preview: preview)
  }

  nonisolated private static func loadImage(_ provider: NSItemProvider) async throws -> PreparedShareImage {
    let type = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true }
      ?? UTType.image.identifier
    let fromFile: PreparedShareImage? = try await withCheckedThrowingContinuation { continuation in
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

  func loadSessions() async {
    loading = true; error = nil
    do {
      let config = try ShareConfig.read()
      guard !config.servers.isEmpty else { throw ShareError.message("Configura al menos un host en Codiby Code.") }
      var found: [ShareSession] = []
      var failed: [String] = []
      for server in config.servers {
        do { found += try await client.sessions(server) } catch { failed.append(server.name) }
      }
      sessions = found.sorted { $0.updatedAt > $1.updatedAt }
      if !failed.isEmpty { error = "Sin conexión: \(failed.joined(separator: ", "))." }
      else if sessions.isEmpty { error = "No hay sesiones disponibles. Crea una en Codiby Code." }
    } catch { self.error = error.localizedDescription }
    loading = false
  }

  func send() async {
    guard canSend, let session = sessions.first(where: { $0.id == selected }) else { return }
    sending = true; error = nil
    do {
      try await client.send(to: session, text: String(text.prefix(8000)), images: images.map(\.payload))
      complete?()
    } catch { self.error = "No se confirmó el envío. Revisa la sesión antes de reintentar para evitar duplicarlo." }
    sending = false
  }
}

private struct ShareView: View {
  @ObservedObject var model: ShareModel
  let cancel: () -> Void

  var body: some View {
    VStack(spacing: 12) {
      HStack {
        Button("Cancelar", action: cancel).disabled(model.sending)
        Spacer()
        Text("Compartir con una sesión").font(.headline)
        Spacer()
        Button("Enviar") { Task { await model.send() } }.disabled(!model.canSend)
      }.padding(.horizontal)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack {
          ForEach(model.images) { image in
            Image(uiImage: image.preview).resizable().scaledToFill().frame(width: 72, height: 72).clipped().cornerRadius(10)
          }
        }.padding(.horizontal)
      }.frame(height: 76)
      ZStack(alignment: .topLeading) {
        TextEditor(text: $model.text).accessibilityLabel("Mensaje opcional")
          .onChange(of: model.text) { value in
            if value.count > 8000 { model.text = String(value.prefix(8000)) }
          }
        if model.text.isEmpty { Text("Mensaje opcional").foregroundColor(.secondary).padding(.top, 8).padding(.leading, 4).allowsHitTesting(false) }
      }.frame(height: 65).padding(.horizontal).disabled(model.sending)
      TextField("Buscar sesión o host", text: $model.search).textFieldStyle(.roundedBorder).padding(.horizontal).disabled(model.sending)
      if model.loading || model.sending { ProgressView(model.sending ? "Enviando…" : "Buscando sesiones…") }
      if let error = model.error {
        VStack {
          Text(error).font(.footnote).foregroundColor(.red)
          if !model.loading && !model.sending && !model.images.isEmpty {
            Button("Actualizar sesiones") { Task { await model.loadSessions() } }
          }
        }.padding(.horizontal)
      }
      List(model.filtered) { session in
        Button {
          model.selected = session.id
        } label: {
          HStack {
            VStack(alignment: .leading, spacing: 4) {
              Text(session.name).foregroundColor(.primary)
              Text("\(session.server.name) · \(session.folder)").font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            if model.selected == session.id { Image(systemName: "checkmark.circle.fill").foregroundColor(.green) }
          }.contentShape(Rectangle())
        }.disabled(model.sending)
      }.listStyle(.plain)
    }.padding(.top, 16).padding(.bottom, 8)
  }
}

class ShareViewController: UIViewController {
  private let model = ShareModel()

  override func viewDidLoad() {
    super.viewDidLoad()
    model.complete = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
    let host = UIHostingController(rootView: ShareView(model: model) { [weak self] in
      self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    })
    addChild(host); view.addSubview(host.view); host.view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      host.view.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    host.didMove(toParent: self)
    Task { await model.prepare(extensionContext?.inputItems as? [NSExtensionItem] ?? []) }
  }
}
