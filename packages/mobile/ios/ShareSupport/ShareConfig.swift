import Foundation

struct ShareServer: Codable {
  let id: String
  let name: String
  let token: String
  let urls: [String]
}

struct ShareConfiguration: Codable {
  let version: Int
  let servers: [ShareServer]
}

enum ShareConfig {
  static let group = "group.com.codiby.code"
  static var file: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
      .appendingPathComponent("share-targets.json")
  }

  static func validate(_ data: Data) throws -> ShareConfiguration {
    let config = try JSONDecoder().decode(ShareConfiguration.self, from: data)
    guard config.version == 1, data.count < 1_000_000,
      config.servers.allSatisfy({ server in
        !server.urls.isEmpty && server.urls.allSatisfy { value in
          guard let url = URL(string: value) else { return false }
          return ["http", "https"].contains(url.scheme ?? "") && url.host != nil
        }
      }) else { throw ShareError.message("Configuración de hosts inválida.") }
    return config
  }

  static func read() throws -> ShareConfiguration {
    guard let file, let data = try? Data(contentsOf: file) else {
      throw ShareError.message("Abre Codiby Code y configura tus hosts antes de compartir.")
    }
    return try validate(data)
  }

  static func write(_ data: Data) throws {
    _ = try validate(data)
    guard let file else { throw ShareError.message("El App Group para compartir no está disponible.") }
    try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}

enum ShareError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    if case let .message(message) = self { return message }
    return nil
  }
}
