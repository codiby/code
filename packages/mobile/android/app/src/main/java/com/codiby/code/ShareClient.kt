package com.codiby.code

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

internal data class ShareServer(val id: String, val name: String, val token: String, val urls: List<String>)
internal data class ShareSession(val id: String, val name: String, val folder: String, val updated: Double, val server: ShareServer, val baseUrl: String)

internal object ShareClient {
    fun servers(config: String): List<ShareServer> {
        val root = JSONObject(config)
        require(root.getInt("version") == 1)
        val items = root.getJSONArray("servers")
        return (0 until items.length()).map { index ->
            val item = items.getJSONObject(index)
            val urls = item.getJSONArray("urls")
            ShareServer(item.getString("id"), item.getString("name"), item.getString("token"),
                (0 until urls.length()).map { urls.getString(it) }.filter {
                    val uri = URI(it)
                    uri.scheme in listOf("http", "https") && !uri.host.isNullOrEmpty()
                })
        }.filter { it.urls.isNotEmpty() }
    }

    private fun request(base: String, path: String, token: String, body: JSONObject? = null): String {
        val connection = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = if (body == null) 5000 else 10000
            connection.readTimeout = if (body == null) 8000 else 30000
            connection.setRequestProperty("Accept", "application/json")
            if (token.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            check(connection.responseCode in 200..299) { "El host respondió ${connection.responseCode}" }
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    fun sessions(server: ShareServer): List<ShareSession> {
        for (url in server.urls) {
            try {
                val rows = JSONArray(request(url, "/sessions", server.token))
                return (0 until rows.length()).mapNotNull { index ->
                    val row = rows.optJSONObject(index) ?: return@mapNotNull null
                    val id = row.optString("id")
                    val name = row.optString("name")
                    if (id.isEmpty() || name.isEmpty() || row.optString("status") in listOf("archived", "closed")) return@mapNotNull null
                    ShareSession(id, name, row.optString("cwd").trimEnd('/').substringAfterLast('/'),
                        row.optDouble("updated_at", 0.0), server, url)
                }
            } catch (_: Exception) { /* Las lecturas pueden probar la siguiente ruta. */ }
        }
        error("No se pudo conectar con ${server.name}")
    }

    fun send(session: ShareSession, text: String, images: List<JSONObject>) {
        // El POST no se repite en otra ruta: una respuesta perdida no debe duplicar el mensaje.
        val path = "/sessions/" + android.net.Uri.encode(session.id) + "/messages"
        request(session.baseUrl, path, session.server.token,
            JSONObject().put("text", text).put("images", JSONArray(images)))
    }
}
