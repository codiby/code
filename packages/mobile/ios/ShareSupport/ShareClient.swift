import Foundation

struct ShareSession: Identifiable {
  let sessionID: String
  let name: String
  let folder: String
  let updatedAt: Double
  let server: ShareServer
  let baseURL: String
  var id: String { "\(server.id):\(sessionID)" }
}

struct SharedImagePayload: Encodable {
  let media_type: String
  let data: String
}

private final class NoShareRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

final class ShareClient {
  private let network: URLSession

  init() {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    network = URLSession(configuration: config, delegate: NoShareRedirects(), delegateQueue: nil)
  }

  deinit { network.invalidateAndCancel() }

  private func request(base: String, path: String, token: String, body: Data? = nil) async throws -> Data {
    guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path),
      ["http", "https"].contains(url.scheme ?? ""), url.host != nil else {
      throw ShareError.message("Dirección del host inválida.")
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: body == nil ? 8 : 30)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.httpMethod = "POST"
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await network.data(for: request)
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
      throw ShareError.message("El host no aceptó la petición.")
    }
    return data
  }

  static func parseSessions(_ data: Data, server: ShareServer, base: String) throws -> [ShareSession] {
    guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      throw ShareError.message("Lista de sesiones inválida.")
    }
    return rows.compactMap { row in
      guard let id = row["id"] as? String, !id.isEmpty, let name = row["name"] as? String, !name.isEmpty,
        !["archived", "closed"].contains(row["status"] as? String ?? "") else { return nil }
      return ShareSession(sessionID: id, name: name,
        folder: ((row["cwd"] as? String) ?? "").split(separator: "/").last.map(String.init) ?? "",
        updatedAt: row["updated_at"] as? Double ?? 0, server: server, baseURL: base)
    }
  }

  func sessions(_ server: ShareServer) async throws -> [ShareSession] {
    for base in server.urls {
      do {
        let data = try await request(base: base, path: "/sessions", token: server.token)
        return try Self.parseSessions(data, server: server, base: base)
      } catch { continue }
    }
    throw ShareError.message("No se pudo conectar con \(server.name).")
  }

  func send(to session: ShareSession, text: String, images: [SharedImagePayload]) async throws {
    struct Body: Encodable { let text: String; let images: [SharedImagePayload] }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    guard let id = session.sessionID.addingPercentEncoding(withAllowedCharacters: allowed) else {
      throw ShareError.message("Sesión inválida.")
    }
    let body = try JSONEncoder().encode(Body(text: text, images: images))
    // No automatic retry: a lost response can follow an accepted POST.
    _ = try await request(base: session.baseURL, path: "/sessions/\(id)/messages", token: session.server.token, body: body)
  }
}
