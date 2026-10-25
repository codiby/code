package com.codiby.code

import android.os.Build
import android.util.Log
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap

/**
 * Puente al gesto predictivo de Android.
 *
 * React Native 0.87 no expone `OnBackInvokedCallback`, y `BackHandler` usa la
 * API antigua basada en `KeyEvent` — que además desactiva el gesto predictivo.
 * Este módulo se registra en el `onBackPressedDispatcher` de la Activity y
 * reenvía a JavaScript el progreso real que reporta el sistema, para que la
 * animación la conduzca el dedo del usuario y no un temporizador nuestro.
 *
 * Basado en el enfoque de honeypathkar/react-native-components.
 */
class PredictiveBackModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackStarted(backEvent: BackEventCompat) {
            emit(EVENT_START, backEvent.toEventMap())
        }

        override fun handleOnBackProgressed(backEvent: BackEventCompat) {
            emit(EVENT_PROGRESS, backEvent.toEventMap())
        }

        override fun handleOnBackCancelled() {
            emit(EVENT_CANCEL, Arguments.createMap())
        }

        override fun handleOnBackPressed() {
            emit(EVENT_COMMIT, Arguments.createMap())
        }
    }

    private var isRegistered = false
    private var reactCallback: OnBackPressedCallback? = null
    private var reactCallbackHost: ComponentActivity? = null

    override fun getName(): String = NAME

    override fun getConstants(): MutableMap<String, Any> =
        hashMapOf(
            // Por debajo de Android 14 el sistema avisa del back pero no
            // reporta progreso: ahí solo llega el commit.
            "progressAvailable" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE),
        )

    @ReactMethod
    fun setMode(mode: String) {
        UiThreadUtil.runOnUiThread {
            val activity = reactApplicationContext.currentActivity as? ComponentActivity
            when (mode) {
                MODE_APP -> {
                    if (activity != null) {
                        attachTo(activity)
                        setReactCallbackEnabled(activity, false)
                    }
                    backCallback.isEnabled = true
                }
                MODE_DEFAULT -> {
                    backCallback.isEnabled = false
                    if (activity != null) setReactCallbackEnabled(activity, true)
                }
                else -> Log.w(NAME, "Modo de back desconocido: $mode")
            }
        }
    }

    @ReactMethod fun addListener(eventName: String) = Unit

    @ReactMethod fun removeListeners(count: Int) = Unit

    override fun invalidate() {
        UiThreadUtil.runOnUiThread {
            backCallback.isEnabled = false
            if (isRegistered) {
                backCallback.remove()
                isRegistered = false
            }
            reactCallback?.isEnabled = true
            reactCallback = null
            reactCallbackHost = null
        }
        super.invalidate()
    }

    private fun attachTo(activity: ComponentActivity) {
        if (isRegistered) backCallback.remove()
        activity.onBackPressedDispatcher.addCallback(backCallback)
        isRegistered = true
    }

    private fun setReactCallbackEnabled(activity: ComponentActivity, enabled: Boolean) {
        findReactCallback(activity)?.isEnabled = enabled
    }

    /**
     * React Native registra su propio `OnBackPressedCallback` para alimentar
     * `BackHandler`. Si se deja activo, se come el evento antes que el nuestro
     * y el gesto nunca llega. No hay API pública para obtenerlo, así que se
     * busca por reflexión; si no aparece, se registra un aviso y el modo
     * queda sin efecto en vez de romper.
     */
    private fun findReactCallback(activity: ComponentActivity): OnBackPressedCallback? {
        if (reactCallbackHost === activity) return reactCallback
        var cls: Class<*>? = activity.javaClass
        while (cls != null && cls != ComponentActivity::class.java) {
            for (field in cls.declaredFields) {
                if (OnBackPressedCallback::class.java.isAssignableFrom(field.type)) {
                    try {
                        field.isAccessible = true
                        val found = field.get(activity) as? OnBackPressedCallback
                        if (found != null) {
                            reactCallback = found
                            reactCallbackHost = activity
                            return found
                        }
                    } catch (e: Exception) {
                        Log.w(NAME, "No se pudo leer el callback de React Native", e)
                        return null
                    }
                }
            }
            cls = cls.superclass
        }
        Log.w(NAME, "No se encontró el callback de React Native")
        return null
    }

    private fun emit(event: String, payload: WritableMap) {
        val context = reactApplicationContext
        if (!context.hasActiveReactInstance()) return
        context.emitDeviceEvent(event, payload)
    }

    private fun BackEventCompat.toEventMap(): WritableMap =
        Arguments.createMap().apply {
            putDouble("progress", progress.toDouble())
            putInt("swipeEdge", swipeEdge)
            putDouble("touchX", touchX.toDouble())
            putDouble("touchY", touchY.toDouble())
        }

    companion object {
        const val NAME = "PredictiveBackModule"
        private const val MODE_APP = "app"
        private const val MODE_DEFAULT = "default"
        private const val EVENT_START = "predictiveBackStart"
        private const val EVENT_PROGRESS = "predictiveBackProgress"
        private const val EVENT_CANCEL = "predictiveBackCancel"
        private const val EVENT_COMMIT = "predictiveBackCommit"
    }
}
