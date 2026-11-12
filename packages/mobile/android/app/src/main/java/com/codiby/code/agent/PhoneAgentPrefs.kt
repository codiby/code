package com.codiby.code.agent

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Switches and audit log for Phone access. They live on the phone, not on the
 * bridge: what an agent may do is decided where the user is, and no bridge —
 * or agent fooled by something it read — can widen it.
 */
object PhoneAgentPrefs {
    const val NAME = "phone-agent"
    const val ENABLED = "enabled"
    const val ALLOW_ACT = "allow_act"
    const val ALLOW_NOTIFICATIONS = "allow_notifications"
    const val ASK_EVERY_ACTION = "ask_every_action"
    private const val DEVICE_ID = "device_id"
    private const val LOG = "log"
    private const val MAX_LOG = 200

    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun enabled(context: Context) = prefs(context).getBoolean(ENABLED, false)
    fun allowAct(context: Context) = prefs(context).getBoolean(ALLOW_ACT, true)
    fun allowNotifications(context: Context) = prefs(context).getBoolean(ALLOW_NOTIFICATIONS, true)
    fun askEveryAction(context: Context) = prefs(context).getBoolean(ASK_EVERY_ACTION, false)

    /** Stable per install, so the bridge recognises the phone across reconnects. */
    @Synchronized
    fun deviceId(context: Context): String {
        val p = prefs(context)
        p.getString(DEVICE_ID, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        p.edit().putString(DEVICE_ID, id).apply()
        return id
    }

    @Synchronized
    fun append(context: Context, host: String, session: String, command: String, summary: String, outcome: String) {
        val p = prefs(context)
        val log = try { JSONArray(p.getString(LOG, "[]")) } catch (_: Exception) { JSONArray() }
        log.put(
            JSONObject()
                .put("t", System.currentTimeMillis())
                .put("host", host)
                .put("session", session)
                .put("command", command)
                .put("summary", summary.take(300))
                .put("outcome", outcome.take(300)),
        )
        val trimmed = JSONArray()
        val start = maxOf(0, log.length() - MAX_LOG)
        for (i in start until log.length()) trimmed.put(log.get(i))
        p.edit().putString(LOG, trimmed.toString()).apply()
    }

    fun log(context: Context): String = prefs(context).getString(LOG, "[]") ?: "[]"

    fun clearLog(context: Context) {
        prefs(context).edit().remove(LOG).apply()
    }
}
