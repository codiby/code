package com.codiby.code.agent

import android.content.Context
import android.util.Log
import com.codiby.code.NetworkWatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * One socket per host to `/phone/ws`, opened from the service itself so it
 * does not depend on the React Native screen being alive.
 *
 * Hosts, routes and tokens come from the `share-targets` config the app
 * already keeps in sync (see `syncShareTargets`): the preferred route first,
 * the others as fallbacks.
 */
class PhoneLink(
    private val context: Context,
    private val hello: () -> JSONObject,
    private val onCommand: (link: Link, frame: JSONObject) -> Unit,
    private val onChange: () -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    /** A LAN address answers in milliseconds or not at all: don't wait 10 s on it. */
    private val localClient = client.newBuilder().connectTimeout(2, TimeUnit.SECONDS).build()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val links = ConcurrentHashMap<String, Link>()

    inner class Link(val serverId: String, val name: String, private val token: String, private val urls: List<String>) {
        // Order-free: the app reorders the routes as it probes them, and that
        // alone must not tear down a working link. The route is chosen here.
        val signature = "$token|${urls.sorted().joinToString(",")}"
        @Volatile var connected = false
            private set
        @Volatile private var socket: WebSocket? = null
        @Volatile private var stopped = false
        private var urlIndex = 0
        private var attempt = 0
        private var retry: ScheduledFuture<*>? = null
        /** Results that found no socket (mid network switch), resent after the next hello. */
        private val outbox = java.util.concurrent.ConcurrentLinkedQueue<Pair<Long, String>>()

        fun start() = scheduler.execute { connect() }

        fun stop() {
            stopped = true
            scheduler.execute {
                retry?.cancel(false)
                socket?.close(1000, "Phone access turned off")
                socket = null
                connected = false
            }
        }

        /**
         * The default network changed: the current socket rides the old one
         * and may hang for a while before failing. Drop it and dial again on
         * the new network at once, starting from the best route for it.
         */
        fun restart(state: NetworkWatcher.State) = scheduler.execute {
            if (stopped) return@execute
            retry?.cancel(false)
            val old = socket
            socket = null
            val was = connected
            connected = false
            old?.cancel()
            attempt = 0
            urlIndex = 0
            if (state.transport != NetworkWatcher.Transport.NONE) connect()
            if (was) onChange()
        }

        fun send(frame: JSONObject): Boolean {
            val text = frame.toString()
            if (socket?.send(text) == true) return true
            // A result is the answer an agent is waiting for: keep it for the
            // next connection instead of dropping it with the old network.
            if (frame.optString("type") == "result") {
                outbox.add(System.currentTimeMillis() to text)
                while (outbox.size > MAX_OUTBOX) outbox.poll()
            }
            return false
        }

        private fun flush(webSocket: WebSocket) {
            val now = System.currentTimeMillis()
            while (true) {
                val (at, text) = outbox.poll() ?: break
                if (now - at < OUTBOX_TTL_MS) webSocket.send(text)
            }
        }

        /**
         * On Wi-Fi the LAN route first, it's the fast one; on mobile data LAN
         * addresses can't be reached, so they're skipped (unless there's
         * nothing else to try).
         */
        private fun routes(): List<String> =
            if (NetworkWatcher.state.transport == NetworkWatcher.Transport.WIFI) {
                urls.sortedBy { if (NetworkWatcher.isPrivate(it)) 0 else 1 }
            } else {
                urls.filterNot(NetworkWatcher::isPrivate).ifEmpty { urls }
            }

        private fun connect() {
            if (stopped || urls.isEmpty()) return
            val candidates = routes()
            val base = candidates[urlIndex % candidates.size].trimEnd('/')
            val query = if (token.isNotBlank()) "?t=" + URLEncoder.encode(token, "UTF-8") else ""
            val request = try {
                Request.Builder().url("$base/phone/ws$query").build()
            } catch (_: IllegalArgumentException) {
                scheduleRetry(failedRoute = true, delayMs = null)
                return
            }
            val dialer = if (NetworkWatcher.isPrivate(base)) localClient else client
            socket = dialer.newWebSocket(request, object : WebSocketListener() {
                // OkHttp runs these on its own threads, where an uncaught
                // exception takes the whole app down: nothing may escape.
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    // A dial from before a network change that opened late.
                    if (stopped || socket !== webSocket) { webSocket.close(1000, null); return }
                    try {
                        connected = true
                        attempt = 0
                        webSocket.send(hello().toString())
                        flush(webSocket)
                        Log.i(TAG, "Linked to $name")
                        onChange()
                    } catch (error: Exception) {
                        Log.e(TAG, "Could not greet $name", error)
                        webSocket.close(1011, null)
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val frame = JSONObject(text)
                        if (frame.optString("type") == "command") onCommand(this@Link, frame)
                    } catch (error: Exception) {
                        Log.w(TAG, "Dropped a frame from $name", error)
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    lost(webSocket, failedRoute = false, delayMs = when (code) {
                        4401 -> 60_000L // token rotated: re-pairing takes a person
                        4409 -> 30_000L // another connection of this phone won
                        else -> null
                    })
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    lost(webSocket, failedRoute = true, delayMs = if (response?.code == 401) 60_000L else null)
                }
            })
        }

        private fun lost(webSocket: WebSocket, failedRoute: Boolean, delayMs: Long?) = scheduler.execute {
            if (socket !== webSocket) return@execute
            socket = null
            val was = connected
            connected = false
            if (was) onChange()
            scheduleRetry(failedRoute, delayMs)
        }

        private fun scheduleRetry(failedRoute: Boolean, delayMs: Long?) {
            if (stopped) return
            // A route that failed hands over to the next one at once; only a
            // full round of failures waits.
            if (failedRoute) urlIndex = (urlIndex + 1) % maxOf(routes().size, 1)
            val wait = delayMs ?: if (failedRoute && urlIndex != 0) 500L else {
                val backoff = minOf(30_000L, 1000L shl minOf(attempt, 5))
                attempt++
                backoff
            }
            retry = scheduler.schedule({ connect() }, wait, TimeUnit.MILLISECONDS)
        }
    }

    /** Opens, keeps or closes links to match the hosts the app knows. */
    @Synchronized
    fun sync() {
        val wanted = readHosts()
        for ((id, link) in links) {
            if (wanted[id]?.signature != link.signature) {
                link.stop()
                links.remove(id)
            }
        }
        for ((id, link) in wanted) {
            if (!links.containsKey(id)) {
                links[id] = link
                link.start()
            }
        }
        onChange()
    }

    @Synchronized
    fun stopAll() {
        links.values.forEach { it.stop() }
        links.clear()
        onChange()
    }

    fun networkChanged(state: NetworkWatcher.State) = links.values.forEach { it.restart(state) }

    fun broadcast(frame: JSONObject) = links.values.forEach { if (it.connected) it.send(frame) }

    fun connectedNames(): List<String> = links.values.filter { it.connected }.map { it.name }

    fun shutdown() {
        stopAll()
        scheduler.shutdown()
    }

    private fun readHosts(): Map<String, Link> {
        val raw = context.getSharedPreferences("share-targets", Context.MODE_PRIVATE).getString("config", null)
            ?: return emptyMap()
        return try {
            val servers = JSONObject(raw).optJSONArray("servers") ?: return emptyMap()
            buildMap {
                for (i in 0 until servers.length()) {
                    val server = servers.optJSONObject(i) ?: continue
                    val id = server.optString("id").takeIf { it.isNotBlank() } ?: continue
                    val urls = server.optJSONArray("urls")?.let { arr ->
                        (0 until arr.length()).map { arr.optString(it) }.filter { it.startsWith("http") }
                    } ?: emptyList()
                    if (urls.isEmpty()) continue
                    put(id, Link(id, server.optString("name").ifBlank { id }, server.optString("token"), urls))
                }
            }
        } catch (_: Exception) {
            emptyMap()
        }
    }

    companion object {
        private const val TAG = "PhoneLink"
        private const val MAX_OUTBOX = 20
        /** The bridge waits 8 s for late answers after a switch; older ones are moot. */
        private const val OUTBOX_TTL_MS = 30_000L
    }
}
