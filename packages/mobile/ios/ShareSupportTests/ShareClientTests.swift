import Foundation

// Runs against the isolated loopback fixture, never a configured Codiby host.
@main
struct ShareClientTests {
  static func main() async throws {
    let base = ProcessInfo.processInfo.environment["SHARE_TEST_URL"]!
    let server = ShareServer(id: "test", name: "Test", token: "share-test-token", urls: ["http://127.0.0.1:1", base])
    let config = try JSONEncoder().encode(ShareConfiguration(version: 1, servers: [server]))
    let decoded = try ShareConfig.validate(config)
    precondition(decoded.servers[0].urls.count == 2)
    do {
      _ = try ShareConfig.validate(Data("{\"version\":2,\"servers\":[]}".utf8))
      fatalError("Unknown config version accepted")
    } catch { }
    let data = Data("""
      [{"id":"same","name":"A","status":"open","cwd":"/test/mobile","updated_at":12},
       {"id":"old","name":"B","status":"closed"},{"id":12,"name":"bad"}]
      """.utf8)
    let parsed = try ShareClient.parseSessions(data, server: server, base: server.urls[1])
    precondition(parsed.count == 1 && parsed[0].folder == "mobile")
    let other = ShareServer(id: "other", name: "Other", token: "", urls: server.urls)
    let second = try ShareClient.parseSessions(data, server: other, base: server.urls[1])
    precondition(parsed[0].id != second[0].id, "Session identities collide across hosts")
    let client = ShareClient()
    let sessions = try await client.sessions(server)
    precondition(sessions.count == 2 && sessions[0].baseURL == server.urls[1], "GET fallback failed")
    let target = sessions.first { $0.sessionID == "share session/one" }!
    try await client.send(to: target, text: "iOS share test", images: [SharedImagePayload(media_type: "image/jpeg", data: "aW1hZ2U=")])
    do {
      try await client.send(to: target, text: "fail once", images: [SharedImagePayload(media_type: "image/jpeg", data: "aW1hZ2U=")])
      fatalError("HTTP failure accepted")
    } catch { }
    print("PASS: iOS config validation, malformed/closed sessions, host identity, GET fallback and POST wire format.")
  }
}
