package com.codiby.code.agent

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.ViewManager

/** What Settings → Phone access needs: state, switches, system screens, log. */
class PhoneAgentModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    override fun getName() = "PhoneAgent"

    @ReactMethod
    fun status(promise: Promise) {
        val service = PhoneAgentService.instance
        val map = Arguments.createMap().apply {
            putBoolean("enabled", PhoneAgentPrefs.enabled(context))
            putBoolean("allowAct", PhoneAgentPrefs.allowAct(context))
            putBoolean("allowNotifications", PhoneAgentPrefs.allowNotifications(context))
            putBoolean("askEveryAction", PhoneAgentPrefs.askEveryAction(context))
            putBoolean("accessibility", service != null || accessibilityOn())
            putBoolean("notificationAccess", NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName))
            putBoolean("postNotifications", NotificationManagerCompat.from(context).areNotificationsEnabled())
            putArray("linkedHosts", Arguments.fromList(service?.linkedHosts() ?: emptyList<String>()))
            putInt("sdk", Build.VERSION.SDK_INT)
        }
        promise.resolve(map)
    }

    @ReactMethod
    fun setOptions(options: ReadableMap, promise: Promise) {
        val edit = PhoneAgentPrefs.prefs(context).edit()
        fun copy(js: String, key: String) {
            if (options.hasKey(js)) edit.putBoolean(key, options.getBoolean(js))
        }
        copy("enabled", PhoneAgentPrefs.ENABLED)
        copy("allowAct", PhoneAgentPrefs.ALLOW_ACT)
        copy("allowNotifications", PhoneAgentPrefs.ALLOW_NOTIFICATIONS)
        copy("askEveryAction", PhoneAgentPrefs.ASK_EVERY_ACTION)
        edit.apply()
        promise.resolve(null)
    }

    @ReactMethod
    fun openAccessibilitySettings(promise: Promise) {
        val component = ComponentName(context, PhoneAgentService::class.java).flattenToString()
        // The service's own page when the OS has one; the list otherwise.
        val detail = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
            .putExtra(Intent.EXTRA_COMPONENT_NAME, component)
        open(detail) || open(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        promise.resolve(null)
    }

    @ReactMethod
    fun openNotificationAccessSettings(promise: Promise) {
        val component = ComponentName(context, PhoneNotificationListener::class.java).flattenToString()
        val opened = Build.VERSION.SDK_INT >= 30 && open(
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component),
        )
        if (!opened) open(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        promise.resolve(null)
    }

    /** App info: where Android 13+ hides "Allow restricted settings". */
    @ReactMethod
    fun openAppDetails(promise: Promise) {
        open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
        promise.resolve(null)
    }

    @ReactMethod
    fun log(promise: Promise) = promise.resolve(PhoneAgentPrefs.log(context))

    @ReactMethod
    fun clearLog(promise: Promise) {
        PhoneAgentPrefs.clearLog(context)
        promise.resolve(null)
    }

    private fun accessibilityOn(): Boolean {
        val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val component = ComponentName(context, PhoneAgentService::class.java)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == component }
    }

    private fun open(intent: Intent): Boolean = try {
        val activity = reactApplicationContext.currentActivity
        if (activity != null) activity.startActivity(intent)
        else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: Exception) {
        false
    }
}

class PhoneAgentPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(PhoneAgentModule(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
