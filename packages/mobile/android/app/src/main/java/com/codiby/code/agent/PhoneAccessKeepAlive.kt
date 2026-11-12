package com.codiby.code.agent

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Holds Phone access in the foreground while it is on.
 *
 * Android 15+ cuts the network of apps in the background
 * (`blocked=APP_BACKGROUND`) even with an accessibility service bound: the
 * links to the hosts dropped the moment Codiby Code left the screen. A
 * foreground service is what keeps network access, and it shows the same
 * "Agents can use this phone" notification the user already sees.
 */
class PhoneAccessKeepAlive : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForeground first, always: a service started with
        // startForegroundService that skips it crashes the app.
        val notification = PhoneAgentService.statusNotification(this, PhoneAgentService.instance?.linkedHosts() ?: emptyList())
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(PhoneAgentService.STATUS_NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(PhoneAgentService.STATUS_NOTIFICATION, notification)
            }
            running = true
        } catch (error: Exception) {
            Log.w(TAG, "Could not hold Phone access in the foreground", error)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!PhoneAgentPrefs.enabled(this) || PhoneAgentService.instance == null) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
    }

    companion object {
        private const val TAG = "PhoneAccessKeepAlive"

        @Volatile
        var running = false
            private set
    }
}
