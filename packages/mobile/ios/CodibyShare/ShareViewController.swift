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
  private var freshHosts = Set<String>()
  private var sendError = false
  var complete: (() -> Void)?

  var filtered: [ShareSession] {
    sessions.filter { search.isEmpty || "\($0.name) \($0.folder) \($0.server.name)".localizedCaseInsensitiveContains(search) }.sorted { $0.pinOrder == $1.pinOrder ? $0.updatedAt > $1.updatedAt : $0.pinOrder > $1.pinOrder }
  }
  var canSend: Bool { !sending && !images.isEmpty && filtered.contains { $0.id == selected } }

  func prepare(_ items: [NSExtensionItem]) async {
    let providers = items.flatMap { $0.attachments ?? [] }.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
    guard !providers.isEmpty && providers.count <= 4 else { loading = false; error = "Comparte entre 1 y 4 imágenes."; return }
    text = String(items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n").prefix(8000))
    if let config = try? ShareConfig.read() { sessions = ShareClient.cachedSessions(ShareConfig.sessionsData(), config: config) }
    let refresh = Task { await loadSessions() }
    do {
      for provider in providers { images.append(try await Self.loadImage(provider)) }
      await refresh.value
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
      var failed: [String] = []
      await withTaskGroup(of: (String, [ShareSession]?).self) { group in
        for server in config.servers {
          group.addTask { [client] in (server.id, try? await client.sessions(server)) }
        }
        for await (serverID, result) in group {
          if let found = result {
            let old = sessions.filter { $0.server.id == serverID }
            sessions.removeAll { $0.server.id == serverID }
            sessions += found.map { session in
              var copy = session
              copy.pinOrder = old.first { $0.id == session.id }?.pinOrder ?? -1
              copy.pinned = old.first { $0.id == session.id }?.pinned ?? false
              copy.preview = old.first { $0.id == session.id }?.preview ?? ""
              return copy
            }
            freshHosts.insert(serverID)
            if let selected, !sessions.contains(where: { $0.id == selected }) { self.selected = nil }
          } else { failed.append(config.servers.first { $0.id == serverID }?.name ?? serverID) }
        }
      }
      if !sending && !sendError && !failed.isEmpty { error = "Sin conexión: \(failed.joined(separator: ", ")). Mostrando chats recientes." }
      else if !sending && !sendError && sessions.isEmpty { error = "No hay chats activos en tus hosts." }
    } catch { self.error = error.localizedDescription }
    loading = false
  }

  func send() async {
    guard canSend, let session = sessions.first(where: { $0.id == selected }) else { return }
    sending = true; sendError = false; error = nil
    do {
      let target: ShareSession
      if freshHosts.contains(session.server.id) { target = session }
      else {
        guard let live = try await client.sessions(session.server).first(where: { $0.id == session.id }) else { throw ShareError.message("El chat ya no está activo") }
        target = live
      }
      try await client.send(to: target, text: String(text.prefix(8000)), images: images.map(\.payload))
      complete?()
    } catch { sendError = true; self.error = "No se confirmó el envío. Revisa la sesión antes de reintentar para evitar duplicarlo." }
    sending = false
  }
}

private struct ShareView: View {
  @ObservedObject var model: ShareModel
  let cancel: () -> Void

  private let green = Color(red: 0.07, green: 0.55, blue: 0.49)

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 16) {
        Button(action: cancel) { Image(systemName: "chevron.left").font(.title2) }.disabled(model.sending)
        Text("Enviar a…").font(.title3.bold())
        Spacer()
        Button { Task { await model.loadSessions() } } label: { Image(systemName: "arrow.clockwise").font(.title3) }.disabled(model.loading || model.sending)
      }.foregroundColor(.white).padding().background(green)
      HStack {
        Image(systemName: "magnifyingglass").foregroundColor(.secondary)
        TextField("Buscar chats o proyectos", text: $model.search).disabled(model.sending)
      }.padding(12).background(Color(.secondarySystemBackground)).cornerRadius(24).padding(.horizontal).padding(.top, 12)
      HStack {
        Text(model.loading ? "Chats recientes · Actualizando…" : "Chats recientes").font(.caption).foregroundColor(.secondary)
        Spacer()
        if model.loading { ProgressView().scaleEffect(0.7) }
      }.padding(.horizontal, 22).padding(.vertical, 8)
      if let error = model.error {
        Button { Task { await model.loadSessions() } } label: {
          Text(error).font(.caption).foregroundColor(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }.disabled(model.loading || model.sending).padding(.horizontal).padding(.bottom, 8)
      }
      List(model.filtered) { session in
        Button { model.selected = session.id } label: {
          HStack(spacing: 14) {
            Text(session.name.split(separator: " ").prefix(2).compactMap { $0.first }.map { String($0).uppercased() }.joined())
              .font(.headline).foregroundColor(green).frame(width: 48, height: 48).background(green.opacity(0.12)).clipShape(Circle())
            VStack(alignment: .leading, spacing: 4) {
              Text(session.name).font(.body.weight(.semibold)).foregroundColor(.primary).lineLimit(1)
              Text("\(session.server.name) · \(session.folder)").font(.caption).foregroundColor(.secondary).lineLimit(1)
              if !session.preview.isEmpty { Text(session.preview).font(.subheadline).foregroundColor(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 0)
            Image(systemName: model.selected == session.id ? "checkmark.circle.fill" : "circle").font(.title2).foregroundColor(model.selected == session.id ? green : Color(.tertiaryLabel))
          }.padding(.vertical, 6).contentShape(Rectangle())
        }.disabled(model.sending).listRowBackground(model.selected == session.id ? green.opacity(0.08) : Color(.systemBackground))
      }.listStyle(.plain)
      VStack(spacing: 10) {
        HStack(spacing: 12) {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
              ForEach(model.images) { image in Image(uiImage: image.preview).resizable().scaledToFill().frame(width: 52, height: 52).clipped().cornerRadius(8) }
            }
          }.frame(width: 60, height: 54)
          ZStack(alignment: .leading) {
            if model.text.isEmpty { Text("Añade un mensaje…").foregroundColor(.secondary).padding(.leading, 5) }
            TextEditor(text: $model.text).opacity(model.text.isEmpty ? 0.5 : 1).accessibilityLabel("Mensaje opcional")
              .onChange(of: model.text) { value in if value.count > 8000 { model.text = String(value.prefix(8000)) } }
          }.frame(height: 48).padding(4).background(Color(.systemBackground)).cornerRadius(16).disabled(model.sending)
        }
        HStack {
          Text(model.sending ? "Enviando…" : model.sessions.first { $0.id == model.selected }?.name ?? "Elige un chat para continuar").font(.subheadline).foregroundColor(.secondary).lineLimit(1)
          Spacer()
          Button { Task { await model.send() } } label: {
            Image(systemName: "paperplane.fill").font(.title3).foregroundColor(.white).frame(width: 48, height: 48).background(green).clipShape(Circle())
          }.disabled(!model.canSend).opacity(model.canSend ? 1 : 0.35).accessibilityLabel("Enviar")
        }
      }.padding().background(Color(.secondarySystemBackground))
    }
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
