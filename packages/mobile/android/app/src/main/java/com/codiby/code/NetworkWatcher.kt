package com.codiby.code

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Tells everyone at once when the default network changes (Wi-Fi ↔ mobile ↔
 * none), so sockets reconnect right away instead of waiting for the old one
 * to time out. Phone access and the app's own sockets both listen.
 */
object NetworkWatcher {
    enum class Transport { WIFI, CELLULAR, OTHER, NONE }

    data class State(val network: String?, val transport: Transport)

    @Volatile
    var state = State(null, Transport.NONE)
        private set

    private val listeners = CopyOnWriteArraySet<(State) -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private var registered = false
    private var pending: Runnable? = null

    @Synchronized
    fun start(context: Context) {
        if (registered) return
        val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return
        state = read(cm)
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = changed(cm)
                override fun onLost(network: Network) = changed(cm)
                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = changed(cm)
            })
            registered = true
        } catch (error: Exception) {
            Log.w("NetworkWatcher", "No network callback", error)
        }
    }

    fun addListener(listener: (State) -> Unit) { listeners.add(listener) }
    fun removeListener(listener: (State) -> Unit) { listeners.remove(listener) }

    /**
     * Callbacks arrive in bursts (lost, available, capabilities…) and
     * capabilities change with signal strength: settle for a moment and only
     * report a different network or transport.
     */
    private fun changed(cm: ConnectivityManager) {
        main.post {
            pending?.let { main.removeCallbacks(it) }
            val run = Runnable {
                val next = read(cm)
                if (next != state) {
                    state = next
                    listeners.forEach { listener ->
                        try { listener(next) } catch (error: Exception) { Log.w("NetworkWatcher", "Listener failed", error) }
                    }
                }
            }
            pending = run
            main.postDelayed(run, SETTLE_MS)
        }
    }

    private fun read(cm: ConnectivityManager): State {
        val network = cm.activeNetwork ?: return State(null, Transport.NONE)
        val caps = cm.getNetworkCapabilities(network) ?: return State(network.toString(), Transport.OTHER)
        val transport = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Transport.WIFI
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Transport.CELLULAR
            else -> Transport.OTHER
        }
        return State(network.toString(), transport)
    }

    /** LAN-only addresses: unreachable over mobile data, so not worth a try there. */
    fun isPrivate(url: String): Boolean {
        val host = try { Uri.parse(url).host?.lowercase() } catch (_: Exception) { null } ?: return false
        if (host == "localhost" || host.endsWith(".local")) return true
        val parts = host.split('.').mapNotNull { it.toIntOrNull() }
        if (parts.size != 4) return false
        return parts[0] == 10 || parts[0] == 127 ||
            (parts[0] == 192 && parts[1] == 168) ||
            (parts[0] == 172 && parts[1] in 16..31) ||
            (parts[0] == 169 && parts[1] == 254)
    }

    private const val SETTLE_MS = 300L
}
