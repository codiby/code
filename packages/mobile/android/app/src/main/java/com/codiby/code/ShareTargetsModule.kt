package com.codiby.code

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager
import org.json.JSONObject

class ShareTargetsModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    override fun getName() = "ShareTargets"

    @ReactMethod
    fun read(requestId: String, promise: Promise) {
        val activity = ShareImageActivity.receiver(requestId)
        if (activity == null) promise.reject("SHARE_ACTIVITY", "No hay imágenes compartidas")
        else activity.readIncoming(promise)
    }

    @ReactMethod
    fun finish(requestId: String, sent: Boolean, promise: Promise) {
        val activity = ShareImageActivity.receiver(requestId)
        if (activity == null) { promise.resolve(null); return }
        activity.runOnUiThread { activity.finish(); promise.resolve(null) }
    }

    @ReactMethod
    fun cacheSessions(snapshot: String, promise: Promise) {
        try {
            org.json.JSONArray(snapshot)
            check(context.getSharedPreferences("share-targets", 0).edit().putString("sessions", snapshot).commit())
            promise.resolve(null)
        } catch (error: Exception) { promise.reject("SHARE_SESSIONS", error) }
    }

    @ReactMethod
    fun configure(config: String, promise: Promise) {
        try {
            require(config.length < 1_000_000 && JSONObject(config).getInt("version") == 1)
            check(context.getSharedPreferences("share-targets", 0).edit().putString("config", config).commit())
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("SHARE_CONFIG", "No se pudo guardar la configuración para compartir", error)
        }
    }
}

class ShareTargetsPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(ShareTargetsModule(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
