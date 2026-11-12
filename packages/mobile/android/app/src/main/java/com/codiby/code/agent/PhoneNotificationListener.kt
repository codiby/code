package com.codiby.code.agent

import android.app.Notification
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * Reads the notifications on the phone and answers them from their own reply
 * box. The commands come through [PhoneAgentService]; this only holds the
 * system's binding, which Android grants from Settings → Notification access.
 */
class PhoneNotificationListener : NotificationListenerService() {
    override fun onListenerConnected() {
        instance = this
        PhoneAgentService.instance?.capabilitiesChanged()
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
        PhoneAgentService.instance?.capabilitiesChanged()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun list(appFilter: String?, limit: Int, labelOf: (String) -> String): JSONArray {
        val out = JSONArray()
        val filter = appFilter?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        val all = try { activeNotifications ?: emptyArray() } catch (_: Exception) { emptyArray() }
        all
            .filter { it.packageName != packageName }
            .filter { (it.notification.flags and Notification.FLAG_GROUP_SUMMARY) == 0 }
            .sortedByDescending { it.postTime }
            .asSequence()
            .map { sbn -> sbn to labelOf(sbn.packageName) }
            .filter { (sbn, label) ->
                filter == null || sbn.packageName.lowercase().contains(filter) || label.lowercase().contains(filter)
            }
            .take(limit)
            .forEach { (sbn, label) -> out.put(describe(sbn, label)) }
        return out
    }

    fun find(key: String): StatusBarNotification? =
        try { activeNotifications?.firstOrNull { it.key == key } } catch (_: Exception) { null }

    /** Sends [text] through the notification's reply action. */
    fun reply(sbn: StatusBarNotification, text: String) {
        val action = replyAction(sbn.notification) ?: error("That notification can't be answered from the phone")
        val inputs = action.remoteInputs ?: error("That notification can't be answered from the phone")
        val results = Bundle()
        inputs.forEach { results.putCharSequence(it.resultKey, text) }
        val intent = Intent()
        RemoteInput.addResultsToIntent(inputs, intent, results)
        action.actionIntent.send(this, 0, intent)
    }

    companion object {
        @Volatile
        var instance: PhoneNotificationListener? = null
            private set

        fun replyAction(notification: Notification): Notification.Action? =
            notification.actions?.firstOrNull { action ->
                action.remoteInputs?.any { it.allowFreeFormInput } == true
            }

        fun title(sbn: StatusBarNotification): String {
            val extras = sbn.notification.extras
            return (extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)
                ?: extras.getCharSequence(Notification.EXTRA_TITLE))?.toString() ?: ""
        }

        private fun describe(sbn: StatusBarNotification, label: String): JSONObject {
            val n = sbn.notification
            val extras = n.extras
            return JSONObject()
                .put("key", sbn.key)
                .put("package", sbn.packageName)
                .put("app", label)
                .put("title", title(sbn).take(200))
                .put("text", body(n).take(1500))
                .put("time", sbn.postTime)
                .put("canReply", replyAction(n) != null)
                .put("ongoing", sbn.isOngoing)
                .apply { extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.let { put("subText", it.toString()) } }
        }

        /** For chats, the last messages with their senders; else the expanded text. */
        private fun body(n: Notification): String {
            val extras = n.extras
            @Suppress("DEPRECATION")
            val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
            if (!messages.isNullOrEmpty()) {
                return messages.takeLast(6).mapNotNull { item ->
                    val bundle = item as? Bundle ?: return@mapNotNull null
                    val sender = bundle.getCharSequence("sender")?.toString()
                    val text = bundle.getCharSequence("text")?.toString() ?: return@mapNotNull null
                    if (sender.isNullOrBlank()) text else "$sender: $text"
                }.joinToString("\n")
            }
            return (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
        }
    }
}
