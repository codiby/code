package com.codiby.code

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

internal data class ShareServer(val id: String, val name: String, val token: String, val urls: List<String>)
internal data class ShareSession(val id: String, val name: String, val folder: String, val updated: Double, val server: ShareServer, val baseUrl: String, val pinned: Boolean = false, val preview: String = "", val pinOrder: Int = -1)

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

    fun cached(config: String, snapshot: String): List<ShareSession> {
        val servers = servers(config).associateBy { it.id }
        val rows = JSONArray(snapshot)
        return (0 until rows.length()).mapNotNull { i ->
            val row = rows.optJSONObject(i) ?: return@mapNotNull null
            val server = servers[row.optString("serverId")] ?: return@mapNotNull null
            val id = row.optString("id"); val name = row.optString("name")
            if (id.isEmpty() || name.isEmpty()) return@mapNotNull null
            ShareSession(id, name, row.optString("cwd").trimEnd('/').substringAfterLast('/'),
                row.optDouble("updated_at", 0.0), server, server.urls.first(), row.optBoolean("pinned"), row.optString("preview"), row.optInt("pinOrder", -1))
        }
    }

    private fun request(base: String, path: String, token: String, body: JSONObject? = null): String {
        val connection = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = if (body == null) 2500 else 10000
            connection.readTimeout = if (body == null) 6000 else 30000
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
        // Compite LAN contra internet: una LAN inaccesible no bloquea el respaldo.
        val pool = java.util.concurrent.Executors.newFixedThreadPool(server.urls.size)
        val completed = java.util.concurrent.ExecutorCompletionService<List<ShareSession>>(pool)
        val requests = server.urls.map { url -> completed.submit(java.util.concurrent.Callable {
            val rows = JSONArray(request(url, "/sessions", server.token))
            (0 until rows.length()).mapNotNull { index ->
                val row = rows.optJSONObject(index) ?: return@mapNotNull null
                val id = row.optString("id"); val name = row.optString("name")
                if (id.isEmpty() || name.isEmpty() || row.optString("status") != "open") return@mapNotNull null
                ShareSession(id, name, row.optString("cwd").trimEnd('/').substringAfterLast('/'),
                    row.optDouble("updated_at", 0.0), server, url)
            }
        }) }
        try {
            repeat(requests.size) {
                try { return completed.take().get() } catch (error: java.util.concurrent.ExecutionException) { /* otra ruta sigue en vuelo */ }
            }
            error("No se pudo conectar con ${server.name}")
        } finally { requests.forEach { it.cancel(true) }; pool.shutdownNow() }
    }

    fun send(session: ShareSession, text: String, images: List<JSONObject>) {
        // El POST no se repite en otra ruta: una respuesta perdida no debe duplicar el mensaje.
        val path = "/sessions/" + android.net.Uri.encode(session.id) + "/messages"
        request(session.baseUrl, path, session.server.token,
            JSONObject().put("text", text).put("images", JSONArray(images)))
    }
}
