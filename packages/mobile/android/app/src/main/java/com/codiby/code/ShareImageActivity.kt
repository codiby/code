package com.codiby.code

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.Base64
import android.view.View
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.math.max

/** UI independiente de React Native: recibe los permisos URI mientras vive el intent. */
class ShareImageActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var status: TextView
    private lateinit var message: EditText
    private lateinit var send: Button
    private lateinit var cancel: Button
    private lateinit var list: ListView
    private lateinit var adapter: ArrayAdapter<String>
    private val sessions = mutableListOf<ShareSession>()
    private var filtered = listOf<ShareSession>()
    private var selected: ShareSession? = null
    private var images = listOf<JSONObject>()
    private var loading = false
    private var sending = false

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun ui(action: () -> Unit) { if (!isFinishing && !isDestroyed) runOnUiThread { if (!isFinishing && !isDestroyed) action() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(12), dp(20), dp(12)); setBackgroundColor(Color.WHITE) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(dp(20) + bars.left, dp(12) + bars.top, dp(20) + bars.right, dp(12) + max(bars.bottom, keyboard.bottom))
            insets
        }
        root.addView(TextView(this).apply { text = "Compartir con una sesión"; textSize = 22f; setTextColor(Color.BLACK) })
        val previews = LinearLayout(this)
        root.addView(HorizontalScrollView(this).apply { addView(previews) }, LinearLayout.LayoutParams(-1, dp(90)))
        status = TextView(this).apply { text = "Preparando imágenes…"; setPadding(0, dp(8), 0, dp(8)) }
        root.addView(status)
        message = EditText(this).apply { filters = arrayOf(android.text.InputFilter.LengthFilter(8000)); hint = "Mensaje opcional"; maxLines = 3; minLines = 1; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE }
        root.addView(message)
        val search = EditText(this).apply { hint = "Buscar sesión o host"; isSingleLine = true }
        root.addView(search)
        list = ListView(this).apply { choiceMode = ListView.CHOICE_MODE_SINGLE }
        adapter = ArrayAdapter(this, android.R.layout.simple_list_item_single_choice, mutableListOf())
        list.adapter = adapter
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { showSessions(s.toString()) }
            override fun afterTextChanged(s: Editable?) {}
        })
        list.setOnItemClickListener { _, _, position, _ -> selected = filtered[position]; updateSend() }
        val buttons = LinearLayout(this)
        cancel = Button(this).apply { text = "Cancelar"; setOnClickListener { finish() } }
        buttons.addView(cancel, LinearLayout.LayoutParams(0, -2, 1f))
        send = Button(this).apply { text = "Enviar"; isEnabled = false; setOnClickListener { submit() } }
        buttons.addView(send, LinearLayout.LayoutParams(0, -2, 1f)); root.addView(buttons)
        setContentView(root)
        root.post {
            if (!isFinishing && !isDestroyed) {
                WindowInsetsControllerCompat(window, root).apply {
                    isAppearanceLightStatusBars = true
                    isAppearanceLightNavigationBars = true
                }
            }
        }
        ViewCompat.requestApplyInsets(root)
        message.setText(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty())
        val uris = runCatching { sharedUris(intent) }.getOrDefault(emptyList())
        if (uris.isEmpty() || uris.size > 4) { status.text = "Comparte entre 1 y 4 imágenes."; return }
        loading = true
        worker.execute {
            try {
                val decoded = uris.map { loadImage(it) }
                images = decoded.map { it.first }
                ui {
                    decoded.forEach { (_, bitmap) ->
                        previews.addView(ImageView(this).apply { setImageBitmap(bitmap); scaleType = ImageView.ScaleType.CENTER_CROP }, LinearLayout.LayoutParams(dp(76), dp(76)).apply { marginEnd = dp(8) })
                    }
                    loadSessions()
                }
            } catch (_: Exception) { ui { loading = false; status.text = "No se pudo leer alguna imagen. Vuelve a compartirla desde la galería." } }
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

    private fun loadImage(uri: Uri): Pair<JSONObject, Bitmap> {
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
        val thumbnail = Bitmap.createScaledBitmap(bitmap, max(1, bitmap.width / 8), max(1, bitmap.height / 8), true)
        if (thumbnail !== bitmap) bitmap.recycle()
        return JSONObject().put("media_type", "image/jpeg").put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)) to thumbnail
    }

    private fun loadSessions() {
        loading = true; selected = null; updateSend()
        status.text = "Buscando sesiones…"
        worker.execute {
            try {
                val config = getSharedPreferences("share-targets", 0).getString("config", null)
                    ?: error("Abre Codiby Code y configura tus hosts antes de compartir.")
                val servers = ShareClient.servers(config)
                check(servers.isNotEmpty()) { "Configura al menos un host en Codiby Code." }
                val found = mutableListOf<ShareSession>(); val failures = mutableListOf<String>()
                servers.forEach { server -> try { found.addAll(ShareClient.sessions(server)) } catch (_: Exception) { failures.add(server.name) } }
                ui {
                    sessions.clear(); sessions.addAll(found.sortedByDescending { it.updated }); loading = false
                    status.text = if (failures.isEmpty()) "${images.size} imagen(es) · Elige la sesión"
                        else "Sin conexión: ${failures.joinToString()}. Puedes reintentar tocando aquí."
                    status.setOnClickListener { if (!loading && !sending) { loading = true; loadSessions() } }
                    if (found.isEmpty() && failures.isEmpty()) status.text = "No hay sesiones disponibles. Crea una en Codiby Code."
                    showSessions(""); updateSend()
                }
            } catch (error: Exception) { ui { loading = false; status.text = error.message; status.setOnClickListener { if (!loading) { loading = true; loadSessions() } } } }
        }
    }

    private fun showSessions(query: String) {
        filtered = sessions.filter { "${it.name} ${it.folder} ${it.server.name}".contains(query, ignoreCase = true) }
        adapter.clear(); adapter.addAll(filtered.map { "${it.name}\n${it.server.name} · ${it.folder}" }); adapter.notifyDataSetChanged()
        list.clearChoices()
        selected?.let { chosen -> filtered.indexOf(chosen).takeIf { it >= 0 }?.let { list.setItemChecked(it, true) } }
        updateSend()
    }

    private fun updateSend() {
        send.isEnabled = selected?.let { it in filtered } == true && images.isNotEmpty() && !loading && !sending
        cancel.isEnabled = !sending
    }

    private fun submit() {
        val target = selected ?: return
        if (sending || loading || images.isEmpty()) return
        sending = true; updateSend(); list.isEnabled = false; message.isEnabled = false; send.text = "Enviando…"
        val text = message.text.toString().take(8000)
        worker.execute {
            try {
                ShareClient.send(target, text, images)
                ui { Toast.makeText(this, "Enviado a ${target.name}", Toast.LENGTH_SHORT).show(); finish() }
            } catch (_: Exception) {
                ui {
                    sending = false; updateSend(); list.isEnabled = true; message.isEnabled = true; send.text = "Enviar"
                    status.text = "No se confirmó el envío. Revisa la sesión antes de reintentar para evitar duplicarlo."
                }
            }
        }
    }

    override fun onDestroy() { worker.shutdownNow(); super.onDestroy() }
}
