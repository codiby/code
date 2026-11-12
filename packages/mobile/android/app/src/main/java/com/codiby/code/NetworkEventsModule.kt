package com.codiby.code

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager

/**
 * `networkChanged` events for the app: its sockets and route probes react to
 * Wi-Fi ↔ mobile ↔ none at once instead of finding out by timing out.
 */
class NetworkEventsModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val listener: (NetworkWatcher.State) -> Unit = { state ->
        if (context.hasActiveReactInstance()) {
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT, Arguments.createMap().apply { putString("transport", name(state)) })
        }
    }

    override fun getName() = "NetworkEvents"

    override fun initialize() {
        super.initialize()
        NetworkWatcher.start(context)
        NetworkWatcher.addListener(listener)
    }

    override fun invalidate() {
        NetworkWatcher.removeListener(listener)
        super.invalidate()
    }

    @ReactMethod
    fun current(promise: Promise) = promise.resolve(name(NetworkWatcher.state))

    // Required by NativeEventEmitter; the listeners live on the JS side.
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Double) = Unit

    private fun name(state: NetworkWatcher.State) = state.transport.name.lowercase()

    companion object {
        const val EVENT = "networkChanged"
    }
}

class NetworkEventsPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(NetworkEventsModule(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
