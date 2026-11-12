package com.codiby.code.agent

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Asks the user before a sensitive step, on top of whatever app is open.
 *
 * An accessibility overlay rather than a notification: it needs no extra
 * permission, it is in front of the user at once, and approving it does not
 * leave the notification shade covering the screen the agent is about to tap.
 *
 * While it waits, the command queue is blocked, so an agent cannot tap
 * "Allow" on its own request.
 */
class ConfirmOverlay(private val service: AccessibilityService) {
    enum class Answer { ALLOW, DENY, TIMEOUT }

    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null

    fun ask(requester: String, action: String, reason: String, timeoutMs: Long = TIMEOUT_MS): Answer {
        val answer = CompletableFuture<Answer>()
        main.post { show(requester, action, reason, answer) }
        val result = try {
            answer.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            Answer.TIMEOUT
        } catch (_: Exception) {
            Answer.DENY
        }
        main.post { dismiss() }
        return result
    }

    private fun show(requester: String, action: String, reason: String, answer: CompletableFuture<Answer>) {
        dismiss()
        val ctx: Context = service
        val dark = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        val surface = if (dark) 0xFF16191E.toInt() else Color.WHITE
        val ink = if (dark) 0xFFEEF1F4.toInt() else 0xFF0D0F12.toInt()
        val muted = if (dark) 0xFF949AA4.toInt() else 0xFF6A707A.toInt()
        val sel = if (dark) 0xFF1B1E23.toInt() else 0xFFF4F5F7.toInt()
        val accent = if (dark) 0xFF2BD49A.toInt() else 0xFF0B7D5C.toInt()
        val onAccent = if (dark) 0xFF0B0C0E.toInt() else Color.WHITE

        fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()
        fun text(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(ctx).apply {
            text = value
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
            if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        fun pill(color: Int) = GradientDrawable().apply { cornerRadius = dp(22f).toFloat(); setColor(color) }
        fun button(label: String, bg: Int, fg: Int, onTap: () -> Unit) = text(label, 14.5f, fg, bold = true).apply {
            gravity = Gravity.CENTER
            background = pill(bg)
            setOnClickListener { onTap() }
            layoutParams = LinearLayout.LayoutParams(0, dp(44f), 1f)
        }

        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20f), dp(18f), dp(20f), dp(16f))
            background = GradientDrawable().apply { cornerRadius = dp(26f).toFloat(); setColor(surface) }
            elevation = dp(12f).toFloat()
            addView(text("$requester wants to", 12.5f, muted))
            addView(text(action, 17f, ink, bold = true).apply { setPadding(0, dp(4f), 0, 0) })
            if (reason.isNotBlank()) {
                addView(text(reason, 13.5f, muted).apply { setPadding(0, dp(8f), 0, 0) })
            }
            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(16f), 0, 0)
                addView(button("Deny", sel, ink) { answer.complete(Answer.DENY) })
                addView(View(ctx), LinearLayout.LayoutParams(dp(8f), 1))
                addView(button("Allow", accent, onAccent) { answer.complete(Answer.ALLOW) })
            })
        }

        val root = FrameLayout(ctx).apply {
            setBackgroundColor(0x66000000)
            // Tapping outside the card is a no, not a pass-through tap.
            setOnClickListener { answer.complete(Answer.DENY) }
            addView(card, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            ).apply { setMargins(dp(12f), 0, dp(12f), dp(28f)) })
        }
        card.setOnClickListener { /* swallow: only the buttons answer */ }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        )
        try {
            (service.getSystemService(Context.WINDOW_SERVICE) as WindowManager).addView(root, params)
            view = root
        } catch (_: Exception) {
            answer.complete(Answer.DENY)
        }
    }

    fun dismiss() {
        val current = view ?: return
        view = null
        try { (service.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(current) } catch (_: Exception) {}
    }

    companion object {
        const val TIMEOUT_MS = 60_000L
    }
}
