package com.codiby.code

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Bundle
import android.net.Uri
import android.util.Base64
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.math.max

/** Solo recibe y prepara adjuntos. Toda la interfaz vive en ShareApp (React Native). */
class ShareImageActivity : ReactActivity() {
    companion object {
        private val receivers = java.util.concurrent.ConcurrentHashMap<String, java.lang.ref.WeakReference<ShareImageActivity>>()
        fun receiver(id: String): ShareImageActivity? = receivers[id]?.get()
    }
    private val requestId = java.util.UUID.randomUUID().toString()
    override fun onCreate(savedInstanceState: Bundle?) {
        receivers[requestId] = java.lang.ref.WeakReference(this)
        super.onCreate(savedInstanceState)
    }
    private val decoder = Executors.newSingleThreadExecutor()
    override fun getMainComponentName() = "CodibyShare"
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
            override fun getLaunchOptions() = Bundle().apply { putString("requestId", requestId) }
        }

    fun readIncoming(promise: Promise) {
        val source = intent
        decoder.execute {
            try {
                val uris = sharedUris(source)
                require(uris.size in 1..4) { "Comparte entre 1 y 4 imágenes." }
                val images = Arguments.createArray()
                uris.forEach { uri ->
                    val image = loadImage(uri)
                    images.pushMap(Arguments.createMap().apply {
                        putString("mediaType", image.getString("mediaType"))
                        putString("data", image.getString("data"))
                    })
                }
                val prefs = getSharedPreferences("share-targets", 0)
                promise.resolve(Arguments.createMap().apply {
                    putString("config", prefs.getString("config", "{\"version\":1,\"servers\":[]}"))
                    putString("snapshot", prefs.getString("sessions", "[]"))
                    putString("text", source.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty().take(8000))
                    putArray("images", images)
                })
            } catch (error: Exception) { promise.reject("SHARE_IMAGES", error.message ?: "No se pudo leer la imagen", error) }
        }
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(intent: Intent): List<Uri> {
        if (intent.action !in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE) || intent.type?.startsWith("image/") != true) return emptyList()
        val streams = if (intent.action == Intent.ACTION_SEND_MULTIPLE) intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            else listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        val candidates = if (streams.isNotEmpty()) streams else (0 until (intent.clipData?.itemCount ?: 0)).mapNotNull { intent.clipData?.getItemAt(it)?.uri }
        return candidates.distinct().filter { it.scheme == "content" }
    }

    private fun loadImage(uri: Uri): JSONObject {
        // Algunos proveedores no devuelven MIME; el decoder valida que sea una imagen.
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, options) }
        require(options.outWidth > 0 && options.outHeight > 0)
        var sample = 1
        while (max(options.outWidth, options.outHeight) / sample > 1920) sample *= 2
        options.inJustDecodeBounds = false; options.inSampleSize = sample
        var bitmap = contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, options) } ?: error("Imagen inválida")
        val orientation = contentResolver.openInputStream(uri).use { stream ->
            try { if (stream == null) 1 else ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) } catch (_: Exception) { 1 }
        }
        val matrix = Matrix().apply {
            when (orientation) {
                2 -> setScale(-1f, 1f)
                3 -> setRotate(180f)
                4 -> setScale(1f, -1f)
                5 -> { setRotate(90f); postScale(-1f, 1f) }
                6 -> setRotate(90f)
                7 -> { setRotate(270f); postScale(-1f, 1f) }
                8 -> setRotate(270f)
            }
        }
        if (!matrix.isIdentity) {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            if (rotated !== bitmap) bitmap.recycle()
            bitmap = rotated
        }
        if (bitmap.hasAlpha()) {
            val opaque = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
            android.graphics.Canvas(opaque).apply { drawColor(Color.WHITE); drawBitmap(bitmap, 0f, 0f, null) }
            bitmap.recycle(); bitmap = opaque
        }
        val bytes = ByteArrayOutputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out); out.toByteArray() }
        require(bytes.size <= 2_250_000) { "Imagen demasiado grande" }
        bitmap.recycle()
        return JSONObject().put("mediaType", "image/jpeg").put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    override fun onDestroy() { receivers.remove(requestId); decoder.shutdownNow(); super.onDestroy() }
}
