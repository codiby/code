package com.codiby.code.agent

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Turns what is on screen into a short numbered list the agent can act on.
 *
 * Only elements that say something or do something are kept: a screen is
 * hundreds of layout containers, and sending them all would bury the twenty
 * that matter. The numbers map back to the live nodes in [nodes] until the
 * next read.
 */
class ScreenReader(private val service: AccessibilityService) {
    /** Element number → node, from the latest read. */
    @Volatile
    var nodes: Map<Int, AccessibilityNodeInfo> = emptyMap()
        private set

    @Volatile
    var foregroundPackage: String = ""
        private set

    fun read(): JSONObject {
        val roots = roots()
        val list = JSONArray()
        val found = HashMap<Int, AccessibilityNodeInfo>()
        var truncated = false
        val pkg = service.rootInActiveWindow?.packageName?.toString()
            ?: roots.firstOrNull()?.packageName?.toString()
            ?: ""
        foregroundPackage = pkg

        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (found.size >= MAX_NODES) { truncated = true; return }
            if (!node.isVisibleToUser) return
            val keep = isUseful(node)
            var childDepth = depth
            if (keep) {
                val id = found.size + 1
                found[id] = node
                list.put(describe(node, id, depth))
                childDepth = depth + 1
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                visit(child, childDepth)
            }
        }
        roots.forEach { visit(it, 0) }
        nodes = found

        val bounds = screenSize()
        return JSONObject()
            .put("app", JSONObject().put("package", pkg).put("label", appLabel(pkg)))
            .put("screen", JSONObject().put("width", bounds.width()).put("height", bounds.height()))
            .put("locked", (service.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked)
            .put("nodes", list)
            .put("truncated", truncated)
    }

    /** The node behind element [id], refreshed; null if it left the screen. */
    fun node(id: Int): AccessibilityNodeInfo? = nodes[id]?.takeIf { it.refresh() }

    /** Deepest element whose bounds contain the point, for taps by coordinates. */
    fun nodeAt(x: Int, y: Int): AccessibilityNodeInfo? {
        var best: AccessibilityNodeInfo? = null
        var bestArea = Long.MAX_VALUE
        val r = Rect()
        for (node in nodes.values) {
            node.getBoundsInScreen(r)
            if (!r.contains(x, y)) continue
            val area = r.width().toLong() * r.height()
            if (area < bestArea) { best = node; bestArea = area }
        }
        return best
    }

    private fun roots(): List<AccessibilityNodeInfo> {
        val windows = try { service.windows } catch (_: Exception) { emptyList<AccessibilityWindowInfo>() }
        val roots = windows
            .filter { w ->
                when (w.type) {
                    AccessibilityWindowInfo.TYPE_INPUT_METHOD,
                    AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> false
                    AccessibilityWindowInfo.TYPE_SYSTEM -> !isBar(w)
                    else -> true
                }
            }
            // Top-most first: a dialog reads before the screen under it.
            .sortedByDescending { it.layer }
            .mapNotNull { it.root }
        if (roots.isNotEmpty()) return roots
        return listOfNotNull(service.rootInActiveWindow)
    }

    private fun isBar(window: AccessibilityWindowInfo): Boolean {
        val title = if (Build.VERSION.SDK_INT >= 24) window.title?.toString()?.lowercase() ?: "" else ""
        return BARS.any { title.contains(it) }
    }

    private fun isUseful(node: AccessibilityNodeInfo): Boolean =
        !node.text.isNullOrBlank() ||
            !node.contentDescription.isNullOrBlank() ||
            node.isClickable || node.isLongClickable ||
            node.isEditable || node.isScrollable || node.isCheckable

    private fun describe(node: AccessibilityNodeInfo, id: Int, depth: Int): JSONObject {
        val r = Rect()
        node.getBoundsInScreen(r)
        val json = JSONObject()
            .put("id", id)
            .put("role", role(node))
            .put("bounds", JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom))
            .put("depth", depth)
        // A password field's text is never sent, not even masked dots' length.
        val text = if (node.isPassword) "(password)" else node.text?.toString()
        if (!text.isNullOrBlank()) json.put("text", text.take(MAX_TEXT))
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { json.put("desc", it.take(MAX_TEXT)) }
        node.viewIdResourceName?.let { json.put("viewId", it) }
        if (node.isClickable || node.isLongClickable) json.put("clickable", true)
        if (node.isEditable) json.put("editable", true)
        if (node.isScrollable) json.put("scrollable", true)
        if (node.isFocused) json.put("focused", true)
        if (node.isCheckable) json.put("checked", node.isChecked)
        if (node.isSelected) json.put("selected", true)
        return json
    }

    private fun role(node: AccessibilityNodeInfo): String {
        val name = node.className?.toString()?.substringAfterLast('.') ?: "View"
        return when {
            node.isEditable -> "EditText"
            name == "View" || name == "ViewGroup" || name.endsWith("Layout") -> if (node.isClickable) "Button" else "View"
            else -> name
        }
    }

    fun appLabel(pkg: String): String = try {
        val pm = service.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Exception) {
        pkg
    }

    @Suppress("DEPRECATION")
    fun screenSize(): Rect {
        val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= 30) return wm.currentWindowMetrics.bounds
        val metrics = android.util.DisplayMetrics()
        wm.defaultDisplay.getRealMetrics(metrics)
        return Rect(0, 0, metrics.widthPixels, metrics.heightPixels)
    }

    companion object {
        private const val MAX_NODES = 350
        private const val MAX_TEXT = 400
        private val BARS = listOf("status bar", "navigation bar", "barra de estado", "barra de navegación")
    }
}
