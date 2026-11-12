package com.codiby.code.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.codiby.code.MainActivity
import com.codiby.code.R
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern

/**
 * Phone access: what lets an agent read and drive this phone.
 *
 * Android binds this service once the user turns it on in Settings →
 * Accessibility. From then on it keeps its own link to each host
 * ([PhoneLink]) and runs the commands that arrive, one at a time, under the
 * switches the user set in the app ([PhoneAgentPrefs]).
 */
class PhoneAgentService : AccessibilityService() {
    private lateinit var reader: ScreenReader
    private lateinit var confirm: ConfirmOverlay
    private var link: PhoneLink? = null
    private val worker = Executors.newSingleThreadExecutor()
    private val shots = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // Held as fields: SharedPreferences keeps its listeners weakly.
    private val agentPrefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        try { applySwitches() } catch (error: Exception) { Log.e(TAG, "Could not apply the switches", error) }
    }
    private val hostsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "config") link?.sync()
    }
    private val offReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            PhoneAgentPrefs.prefs(context).edit().putBoolean(PhoneAgentPrefs.ENABLED, false).apply()
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        reader = ScreenReader(this)
        confirm = ConfirmOverlay(this)
        // Everything here runs in the app's process: a throw would crash the
        // whole app on every launch while the service stays switched on.
        try {
            PhoneAgentPrefs.prefs(this).registerOnSharedPreferenceChangeListener(agentPrefsListener)
            getSharedPreferences("share-targets", MODE_PRIVATE).registerOnSharedPreferenceChangeListener(hostsListener)
            ContextCompat.registerReceiver(this, offReceiver, IntentFilter(ACTION_TURN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED)
        } catch (error: Exception) {
            Log.e(TAG, "Phone access could not start its listeners", error)
        }
        try {
            val connectivity = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { link?.kick() }
            }.also { connectivity.registerDefaultNetworkCallback(it) }
        } catch (error: Exception) {
            // Only speeds up reconnecting; the backoff still gets there.
            networkCallback = null
            Log.w(TAG, "No network callback", error)
        }
        try {
            applySwitches()
        } catch (error: Exception) {
            Log.e(TAG, "Phone access could not start", error)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    override fun onUnbind(intent: Intent?): Boolean {
        teardown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    private fun teardown() {
        if (instance !== this) return
        instance = null
        link?.shutdown()
        link = null
        if (::confirm.isInitialized) confirm.dismiss()
        PhoneAgentPrefs.prefs(this).unregisterOnSharedPreferenceChangeListener(agentPrefsListener)
        getSharedPreferences("share-targets", MODE_PRIVATE).unregisterOnSharedPreferenceChangeListener(hostsListener)
        try { unregisterReceiver(offReceiver) } catch (_: Exception) {}
        networkCallback?.let {
            try { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } catch (_: Exception) {}
        }
        networkCallback = null
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(STATUS_NOTIFICATION)
        worker.shutdownNow()
        shots.shutdownNow()
    }

    /** Re-reads the switches: connects, disconnects or just reports the change. */
    private fun applySwitches() {
        if (PhoneAgentPrefs.enabled(this)) {
            val current = link ?: PhoneLink(this, ::hello, ::onCommand) { main.post { updateStatus() } }.also {
                link = it
                it.sync()
            }
            current.broadcast(JSONObject().put("type", "capabilities").put("capabilities", capabilities()))
        } else {
            link?.stopAll()
            link = null
        }
        main.post { updateStatus() }
    }

    fun capabilitiesChanged() = applySwitches()

    fun linkedHosts(): List<String> = link?.connectedNames() ?: emptyList()

    private fun capabilities(): JSONObject {
        val on = PhoneAgentPrefs.enabled(this)
        return JSONObject()
            .put("read", on)
            .put("act", on && PhoneAgentPrefs.allowAct(this))
            .put("notifications", on && PhoneAgentPrefs.allowNotifications(this) && PhoneNotificationListener.instance != null)
    }

    private fun hello(): JSONObject {
        val deviceName = Settings.Global.getString(contentResolver, "device_name")?.takeIf { it.isNotBlank() } ?: Build.MODEL
        val version = try { packageManager.getPackageInfo(packageName, 0).versionName ?: "" } catch (_: Exception) { "" }
        return JSONObject()
            .put("type", "hello")
            .put("deviceId", PhoneAgentPrefs.deviceId(this))
            .put("name", deviceName)
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", Build.VERSION.RELEASE)
            .put("appVersion", version)
            .put("capabilities", capabilities())
    }

    // ---------------------------------------------------------------- commands

    private class Declined(message: String) : Exception(message)

    private fun onCommand(target: PhoneLink.Link, frame: JSONObject) {
        val id = frame.optString("id")
        val command = frame.optString("command")
        val args = frame.optJSONObject("args") ?: JSONObject()
        val who = frame.optJSONObject("requester")?.optString("sessionName")?.takeIf { it.isNotBlank() } ?: "An agent"
        if (worker.isShutdown) return
        try { worker.execute {
            var summary = command
            val reply = JSONObject().put("type", "result").put("id", id)
            try {
                val (text, result) = run(command, args, who)
                summary = text
                reply.put("ok", true).put("result", result)
                PhoneAgentPrefs.append(this, target.name, who, command, summary, "done")
            } catch (error: Exception) {
                val message = error.message ?: "The phone could not do it"
                reply.put("ok", false).put("error", message)
                val outcome = if (error is Declined) "declined" else "error: $message"
                PhoneAgentPrefs.append(this, target.name, who, command, describeArgs(command, args), outcome)
            }
            target.send(reply)
        } } catch (_: java.util.concurrent.RejectedExecutionException) {
            // The service is shutting down; the bridge times the request out.
        }
    }

    private fun run(command: String, args: JSONObject, who: String): Pair<String, Any> {
        if (!PhoneAgentPrefs.enabled(this)) throw Declined("Phone access is turned off on the phone")
        return when (command) {
            "read_screen" -> {
                val screen = reader.read()
                if (args.optBoolean("screenshot")) screen.put("screenshot", screenshot())
                "Read the screen (${screen.optJSONObject("app")?.optString("label")})" to screen
            }
            "act" -> {
                if (!PhoneAgentPrefs.allowAct(this)) throw Declined("Acting on the phone is turned off. The user can allow it in Codiby Code → Settings → Phone access.")
                act(args, who)
            }
            "list_apps" -> "Listed apps" to JSONObject().put("apps", apps(args.optString("query")))
            "notifications" -> {
                val listener = notificationListener()
                val list = listener.list(args.optString("app"), args.optInt("limit", 30).coerceIn(1, 100)) { reader.appLabel(it) }
                "Read ${list.length()} notifications" to JSONObject().put("notifications", list)
            }
            "reply_notification" -> {
                val listener = notificationListener()
                val sbn = listener.find(args.optString("key")) ?: throw IllegalStateException("That notification is gone. List them again.")
                val text = args.optString("text").trim().ifEmpty { throw IllegalArgumentException("text is required") }
                val app = reader.appLabel(sbn.packageName)
                val action = "Reply to ${PhoneNotificationListener.title(sbn).ifBlank { app }} in $app: “${text.take(300)}”"
                approve(who, action, args.optString("reason"))
                listener.reply(sbn, text)
                "Replied in $app" to JSONObject().put("done", "Sent the reply in $app.")
            }
            else -> throw IllegalArgumentException("Unknown command: $command")
        }
    }

    private fun notificationListener(): PhoneNotificationListener {
        if (!PhoneAgentPrefs.allowNotifications(this)) {
            throw Declined("Reading notifications is turned off. The user can allow it in Codiby Code → Settings → Phone access.")
        }
        return PhoneNotificationListener.instance
            ?: throw IllegalStateException("Notification access is not granted. The user can grant it in Codiby Code → Settings → Phone access.")
    }

    private fun approve(who: String, action: String, reason: String) {
        when (confirm.ask(who, action, reason)) {
            ConfirmOverlay.Answer.ALLOW -> Thread.sleep(250) // let the overlay leave first
            ConfirmOverlay.Answer.DENY -> throw Declined("The user declined: $action")
            ConfirmOverlay.Answer.TIMEOUT -> throw Declined("Nobody approved it on the phone within a minute: $action")
        }
    }

    private fun act(args: JSONObject, who: String): Pair<String, JSONObject> {
        val power = getSystemService(POWER_SERVICE) as PowerManager
        if (!power.isInteractive) throw IllegalStateException("The phone's screen is off. Ask the user to turn it on and unlock it.")
        val action = args.optString("action")
        val foreground = rootInActiveWindow?.packageName?.toString() ?: reader.foregroundPackage
        val app = reader.appLabel(foreground)
        if (action in TOUCHES && foreground == packageName) {
            throw Declined("Codiby Code is on screen. Touches inside it are blocked so no agent can change its own access. Go home or open another app first.")
        }

        val node: AccessibilityNodeInfo? = when {
            args.has("node") -> reader.node(args.optInt("node"))
                ?: throw IllegalStateException("Element ${args.optInt("node")} is no longer on screen. Read the screen again.")
            args.has("x") && args.has("y") && action != "swipe" -> reader.nodeAt(args.optInt("x"), args.optInt("y"))
            else -> null
        }
        val label = node?.let { labelOf(it) } ?: if (args.has("x")) "(${args.optInt("x")}, ${args.optInt("y")})" else ""
        val description = when (action) {
            "tap" -> "Tap $label in $app"
            "long_press" -> "Long-press $label in $app"
            "type" -> "Type “${args.optString("text").take(120)}”${if (label.isNotEmpty()) " into $label" else ""} in $app"
            "scroll" -> "Scroll ${args.optString("direction", "down")} in $app"
            "swipe" -> "Swipe in $app"
            "key" -> "Press ${args.optString("key")}"
            "open_app" -> "Open ${args.optString("app")}"
            else -> throw IllegalArgumentException("Unknown action: $action")
        }

        val sensitive = PhoneAgentPrefs.askEveryAction(this) ||
            args.optBoolean("confirm") ||
            (action in TOUCHES && isSystemSettings(foreground)) ||
            (action == "tap" || action == "long_press") && node != null && looksSensitive(node) ||
            action == "key" && args.optString("key") == "enter" && !isSearchField(rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT))
        if (sensitive) approve(who, description, args.optString("reason"))

        when (action) {
            "tap", "long_press" -> touch(node, args, long = action == "long_press")
            "type" -> type(node, args.optString("text"), args.optBoolean("append"))
            "scroll" -> scroll(node, args.optString("direction", "down"))
            "swipe" -> {
                require(args.has("x") && args.has("y") && args.has("x2") && args.has("y2")) { "swipe needs x, y, x2 and y2" }
                gesture(args.optInt("x"), args.optInt("y"), args.optInt("x2"), args.optInt("y2"), 300)
            }
            "key" -> key(args.optString("key"))
            "open_app" -> openApp(args.optString("app"))
        }

        Thread.sleep(SETTLE_MS)
        val screen = reader.read()
        return description to JSONObject().put("done", "$description — done.").put("screen", screen)
    }

    private fun touch(node: AccessibilityNodeInfo?, args: JSONObject, long: Boolean) {
        val nodeAction = if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
        if (node != null && args.has("node")) {
            val target = ancestors(node).firstOrNull { if (long) it.isLongClickable else it.isClickable }
            if (target?.performAction(nodeAction) == true) return
            val r = Rect().also { node.getBoundsInScreen(it) }
            gesture(r.centerX(), r.centerY(), r.centerX(), r.centerY(), if (long) 650 else 60)
            return
        }
        require(args.has("x") && args.has("y")) { "Pass node, or x and y" }
        gesture(args.optInt("x"), args.optInt("y"), args.optInt("x"), args.optInt("y"), if (long) 650 else 60)
    }

    private fun type(node: AccessibilityNodeInfo?, text: String, append: Boolean) {
        val field = node ?: rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: throw IllegalStateException("No text field is focused. Pass the field's node number.")
        if (!field.isEditable) throw IllegalStateException("${labelOf(field)} is not a text field")
        if (!field.isFocused) field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val showingHint = Build.VERSION.SDK_INT >= 26 && field.isShowingHintText
        val current = if (append && !showingHint) field.text?.toString() ?: "" else ""
        val bundle = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, current + text)
        }
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)) {
            throw IllegalStateException("${labelOf(field)} did not accept the text")
        }
    }

    private fun scroll(node: AccessibilityNodeInfo?, direction: String) {
        val target = node?.let { n -> ancestors(n).firstOrNull { it.isScrollable } } ?: largestScrollable()
        if (target != null) {
            val directional = when (direction) {
                "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP
                "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN
                "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT
                else -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT
            }
            if (target.actionList.any { it.id == directional.id } && target.performAction(directional.id)) return
            val fallback = if (direction == "up" || direction == "left") AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            if (target.performAction(fallback)) return
        }
        // Nothing scrollable reported itself: swipe across the middle.
        val r = reader.screenSize()
        val cx = r.centerX(); val cy = r.centerY()
        val dy = r.height() / 4; val dx = r.width() / 3
        when (direction) {
            "up" -> gesture(cx, cy - dy, cx, cy + dy, 350)
            "down" -> gesture(cx, cy + dy, cx, cy - dy, 350)
            "left" -> gesture(cx - dx, cy, cx + dx, cy, 350)
            else -> gesture(cx + dx, cy, cx - dx, cy, 350)
        }
    }

    private fun key(name: String) {
        val ok = when (name) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "quick_settings" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            "enter" -> {
                if (Build.VERSION.SDK_INT < 30) throw IllegalStateException("Enter needs Android 11 or newer")
                val field = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                    ?: throw IllegalStateException("No text field is focused")
                field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            }
            else -> throw IllegalArgumentException("Unknown key: $name")
        }
        if (!ok) throw IllegalStateException("The phone refused the $name key")
    }

    private fun openApp(query: String) {
        val wanted = query.trim().lowercase()
        require(wanted.isNotEmpty()) { "app is required" }
        val all = launchable()
        val match = all.firstOrNull { it.second.lowercase() == wanted }
            ?: all.firstOrNull { it.first.lowercase() == wanted }
            ?: all.firstOrNull { it.first.lowercase().contains(wanted) }
            ?: throw IllegalStateException("No app called \"$query\" is installed. Use phone_list_apps.")
        val intent = packageManager.getLaunchIntentForPackage(match.second)
            ?: throw IllegalStateException("${match.first} can't be opened")
        startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** (label, package) of every app with a launcher icon. */
    private fun launchable(): List<Pair<String, String>> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return packageManager.queryIntentActivities(intent, 0)
            .map { it.loadLabel(packageManager).toString() to it.activityInfo.packageName }
            .distinctBy { it.second }
            .sortedBy { it.first.lowercase() }
    }

    private fun apps(query: String): JSONArray {
        val q = query.trim().lowercase()
        val out = JSONArray()
        launchable()
            .filter { q.isEmpty() || it.first.lowercase().contains(q) || it.second.lowercase().contains(q) }
            .forEach { out.put(JSONObject().put("label", it.first).put("package", it.second)) }
        return out
    }

    private fun gesture(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) {
        val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(1))
        val done = CompletableFuture<Boolean>()
        val sent = dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { done.complete(true) }
            override fun onCancelled(gestureDescription: GestureDescription?) { done.complete(false) }
        }, main)
        if (!sent || !done.get(5, TimeUnit.SECONDS)) throw IllegalStateException("The phone did not perform the gesture")
    }

    private fun screenshot(): JSONObject {
        if (Build.VERSION.SDK_INT < 30) throw IllegalStateException("Screenshots need Android 11 or newer")
        val done = CompletableFuture<JSONObject>()
        takeScreenshot(Display.DEFAULT_DISPLAY, shots, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                try {
                    val hardware = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        ?: throw IllegalStateException("Empty screenshot")
                    val bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false)
                    result.hardwareBuffer.close()
                    val scale = minOf(1f, SHOT_WIDTH.toFloat() / bitmap.width)
                    val scaled = Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true)
                    val bytes = ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, 70, it) }.toByteArray()
                    done.complete(JSONObject().put("mime", "image/jpeg").put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
                } catch (error: Exception) {
                    done.completeExceptionally(error)
                }
            }

            override fun onFailure(errorCode: Int) {
                done.completeExceptionally(IllegalStateException(
                    if (errorCode == ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) "This app blocks screenshots" else "Screenshot failed ($errorCode)",
                ))
            }
        })
        return done.get(10, TimeUnit.SECONDS)
    }

    // ----------------------------------------------------------------- helpers

    private fun ancestors(node: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> =
        generateSequence(node) { it.parent }.take(8)

    private fun largestScrollable(): AccessibilityNodeInfo? {
        val r = Rect()
        return reader.nodes.values.filter { it.isScrollable && it.refresh() }
            .maxByOrNull { it.getBoundsInScreen(r); r.width().toLong() * r.height() }
    }

    private fun labelOf(node: AccessibilityNodeInfo): String {
        val own = node.text?.toString()?.takeIf { it.isNotBlank() && !node.isPassword }
            ?: node.contentDescription?.toString()?.takeIf { it.isNotBlank() }
            ?: descendantsText(node).firstOrNull()
            ?: node.viewIdResourceName?.substringAfter(":id/")
        return if (own != null) "“${own.take(60)}”" else node.className?.toString()?.substringAfterLast('.') ?: "element"
    }

    private fun descendantsText(node: AccessibilityNodeInfo, depth: Int = 0): List<String> {
        if (depth > 3) return emptyList()
        val out = mutableListOf<String>()
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            child.text?.toString()?.takeIf { it.isNotBlank() }?.let(out::add)
            child.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let(out::add)
            out += descendantsText(child, depth + 1)
            if (out.size > 6) break
        }
        return out
    }

    /** Send, pay, buy, delete, confirm…: what a tap must not do unasked. */
    private fun looksSensitive(node: AccessibilityNodeInfo): Boolean {
        val words = buildList {
            ancestors(node).take(3).forEach { n ->
                n.text?.let { add(it.toString()) }
                n.contentDescription?.let { add(it.toString()) }
                n.viewIdResourceName?.let { add(it.substringAfter(":id/").replace('_', ' ')) }
            }
            addAll(descendantsText(node))
        }
        return words.any { SENSITIVE.matcher(it).find() }
    }

    private fun isSearchField(node: AccessibilityNodeInfo?): Boolean {
        node ?: return false
        val hint = if (Build.VERSION.SDK_INT >= 26) node.hintText?.toString() ?: "" else ""
        val text = "${node.viewIdResourceName ?: ""} $hint ${node.contentDescription ?: ""}".lowercase()
        return text.contains("search") || text.contains("buscar") || text.contains("busca")
    }

    private fun isSystemSettings(pkg: String): Boolean =
        pkg.contains("settings") || pkg.contains("permissioncontroller") || pkg.contains("packageinstaller")

    private fun describeArgs(command: String, args: JSONObject): String = when (command) {
        "act" -> "${args.optString("action")} ${args.optString("reason")}".trim()
        "reply_notification" -> "reply: ${args.optString("text").take(80)}"
        else -> command
    }

    private fun updateStatus() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (!PhoneAgentPrefs.enabled(this)) {
            manager.cancel(STATUS_NOTIFICATION)
            return
        }
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(STATUS_CHANNEL, "Phone access", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while agents can use this phone"
                    setShowBadge(false)
                },
            )
        }
        val hosts = linkedHosts()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val off = PendingIntent.getBroadcast(
            this, 1, Intent(ACTION_TURN_OFF).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_phone_agent)
            .setContentTitle("Agents can use this phone")
            .setContentText(if (hosts.isEmpty()) "Waiting for your hosts…" else "Linked to ${hosts.joinToString(", ")}")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .addAction(0, "Turn off", off)
            .build()
        try { manager.notify(STATUS_NOTIFICATION, notification) } catch (_: SecurityException) {}
    }

    companion object {
        @Volatile
        var instance: PhoneAgentService? = null
            private set

        private const val TAG = "PhoneAgent"
        private const val ACTION_TURN_OFF = "com.codiby.code.PHONE_ACCESS_OFF"
        private const val STATUS_CHANNEL = "phone_access"
        private const val STATUS_NOTIFICATION = 7301
        private const val SETTLE_MS = 700L
        private const val SHOT_WIDTH = 720
        private val TOUCHES = setOf("tap", "long_press", "type", "scroll", "swipe")
        private val SENSITIVE: Pattern = Pattern.compile(
            "\\b(send|enviar|env[ií]a|pay|pagar|paga|buy|comprar|compra|purchase|checkout|order|ordenar|pedir|" +
                "delete|eliminar|elimina|borrar|borra|remove|quitar|transfer|transferir|confirm|confirmar|" +
                "accept|aceptar|allow|permitir|publish|publicar|post|share|compartir|call|llamar|sign|firmar|" +
                "submit|install|instalar|uninstall|desinstalar|reset|restablecer|log ?out|sign ?out|cerrar sesi[oó]n|" +
                "subscribe|suscribir|unsubscribe|donate|donar)\\b",
            // No UNICODE_CHARACTER_CLASS: Android rejects it, and its ICU regex
            // already treats accented letters as word characters for `\\b`.
            Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE,
        )
    }
}
