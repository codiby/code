package com.codiby.code

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.ExifInterface
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.math.max

/** Selector nativo que comparte la foto de chats del inicio, incluso en arranque frío. */
class ShareImageActivity : Activity() {
    private val worker = Executors.newFixedThreadPool(4)
    private val decoder = Executors.newSingleThreadExecutor()
    private lateinit var status: TextView
    private lateinit var message: EditText
    private lateinit var search: EditText
    private lateinit var send: TextView
    private lateinit var cancel: TextView
    private lateinit var destination: TextView
    private lateinit var list: ListView
    private lateinit var adapter: BaseAdapter
    private val sessions = mutableListOf<ShareSession>()
    private var filtered = listOf<ShareSession>()
    private var selected: ShareSession? = null
    private var images = listOf<JSONObject>()
    private var loading = false
    private var sending = false
    private var sendError = false
    private var imageError = false
    private val freshHosts = mutableSetOf<String>()
    private val ink = Color.rgb(15, 23, 42)
    private val muted = Color.rgb(100, 116, 139)
    private val green = Color.rgb(18, 140, 126)

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun ui(action: () -> Unit) { if (!isFinishing && !isDestroyed) runOnUiThread { if (!isFinishing && !isDestroyed) action() } }
    private fun shape(color: Int, radius: Int = 12) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun label(value: String, size: Float, color: Int = ink) = TextView(this).apply { text = value; textSize = size; setTextColor(color) }
    private fun key(session: ShareSession) = "${session.server.id}:${session.id}"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE); isFocusableInTouchMode = true }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, keyboard.bottom))
            insets
        }
        val header = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(dp(16), 0, dp(12), 0); setBackgroundColor(green) }
        cancel = label("‹", 36f, Color.WHITE).apply { contentDescription = "Cancelar"; gravity = android.view.Gravity.CENTER; setOnClickListener { finish() } }
        header.addView(cancel, LinearLayout.LayoutParams(dp(40), dp(56)))
        header.addView(label("Enviar a…", 21f, Color.WHITE).apply { setTypeface(null, Typeface.BOLD) }, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(label("↻", 28f, Color.WHITE).apply { contentDescription = "Actualizar chats"; gravity = android.view.Gravity.CENTER; setOnClickListener { if (!loading && !sending) loadSessions() } }, LinearLayout.LayoutParams(dp(44), dp(48)))
        root.addView(header)
        search = EditText(this).apply {
            hint = "Buscar chats o proyectos"; textSize = 16f; isSingleLine = true
            setTextColor(ink); setHintTextColor(muted); background = shape(Color.rgb(241,245,249), 24)
            setPadding(dp(18), 0, dp(18), 0)
        }
        root.addView(search, LinearLayout.LayoutParams(-1, dp(44)).apply { setMargins(dp(16), dp(12), dp(16), dp(4)) })
        status = label("Tus chats recientes", 12f, muted).apply { setPadding(dp(22), dp(8), dp(16), dp(8)); setOnClickListener { if (!loading && !sending) loadSessions() } }
        root.addView(status)
        adapter = object : BaseAdapter() {
            override fun getCount() = filtered.size
            override fun getItem(position: Int) = filtered[position]
            override fun getItemId(position: Int) = position.toLong()
            override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
                val session = filtered[position]
                val chosen = selected?.let { key(it) == key(session) } == true
                val row = LinearLayout(this@ShareImageActivity).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL
                    setPadding(dp(18), dp(12), dp(18), dp(12)); minimumHeight = dp(84)
                    setBackgroundColor(if (chosen) Color.rgb(232, 247, 240) else Color.WHITE)
                }
                val colors = intArrayOf(0xffdcece7.toInt(),0xffe4e8f7.toInt(),0xfff9eadb.toInt(),0xfff3e2ec.toInt())
                val initials = session.name.trim().split(Regex("\\s+")).take(2).mapNotNull { it.firstOrNull()?.uppercase() }.joinToString("")
                row.addView(label(initials, 18f, green).apply { gravity = android.view.Gravity.CENTER; setTypeface(null, Typeface.BOLD); background = shape(colors[(session.server.id.hashCode() and Int.MAX_VALUE) % colors.size], 30) }, LinearLayout.LayoutParams(dp(48), dp(48)))
                val texts = LinearLayout(this@ShareImageActivity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14),0,dp(8),0) }
                texts.addView(label(session.name, 16f).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setTypeface(null, Typeface.BOLD) })
                texts.addView(label(listOf(session.server.name, session.folder).filter { it.isNotEmpty() }.joinToString(" · "), 12f, muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0,dp(4),0,0) })
                if (session.preview.isNotBlank()) texts.addView(label(session.preview.replace('\n', ' '), 13f, muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0,dp(3),0,0) })
                row.addView(texts, LinearLayout.LayoutParams(0,-2,1f))
                row.addView(label(if (chosen) "✓" else "○", 24f, if (chosen) green else Color.rgb(203,213,225)).apply { gravity = android.view.Gravity.CENTER; contentDescription = if (chosen) "Seleccionado" else "Seleccionar chat" }, LinearLayout.LayoutParams(dp(32),dp(40)))
                return row
            }
        }
        list = ListView(this).apply { divider = null; adapter = this@ShareImageActivity.adapter; clipToPadding = false }
        list.setOnItemClickListener { _, _, position, _ -> selected = filtered[position]; adapter.notifyDataSetChanged(); updateSend() }
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        val footer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16),dp(12),dp(16),dp(12)); setBackgroundColor(Color.rgb(248,250,252)) }
        val compose = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL }
        val previews = LinearLayout(this)
        compose.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(previews) }, LinearLayout.LayoutParams(dp(64),dp(56)))
        message = EditText(this).apply {
            filters = arrayOf(android.text.InputFilter.LengthFilter(8000)); hint = "Añade un mensaje…"; textSize = 15f
            maxLines = 3; minLines = 1; setTextColor(ink); setHintTextColor(muted)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            background = shape(Color.WHITE,16); setPadding(dp(12),dp(8),dp(12),dp(8))
        }
        compose.addView(message, LinearLayout.LayoutParams(0,-2,1f).apply { marginStart = dp(10) }); footer.addView(compose)
        val actions = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(0,dp(10),0,0) }
        destination = label("Elige un chat para continuar", 13f, muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        actions.addView(destination, LinearLayout.LayoutParams(0,-2,1f))
        send = label("➤",24f,Color.WHITE).apply { gravity = android.view.Gravity.CENTER; contentDescription = "Enviar"; background = shape(green,28); setOnClickListener { submit() } }
        actions.addView(send,LinearLayout.LayoutParams(dp(48),dp(48)).apply { marginStart = dp(12) }); footer.addView(actions); root.addView(footer)
        setContentView(root)
        window.statusBarColor = green
        root.post {
            if (!isFinishing && !isDestroyed) WindowInsetsControllerCompat(window,root).apply { isAppearanceLightStatusBars = true; isAppearanceLightNavigationBars = true }
        }
        ViewCompat.requestApplyInsets(root)
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { showSessions(s.toString()) }
            override fun afterTextChanged(s: Editable?) {}
        })
        message.setText(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty())
        // Pinta la MISMA lista persistida del inicio antes de esperar la red o el decoder.
        val prefs = getSharedPreferences("share-targets",0)
        runCatching { ShareClient.cached(prefs.getString("config", "{}")!!, prefs.getString("sessions", "[]")!!) }.getOrNull()?.let { sessions.addAll(it) }
        showSessions("")
        val uris = runCatching { sharedUris(intent) }.getOrDefault(emptyList())
        if (uris.isEmpty() || uris.size > 4) { status.text = "Comparte entre 1 y 4 imágenes."; updateSend(); return }
        loadSessions()
        decoder.execute {
            try {
                val decoded = uris.map { loadImage(it) }
                ui {
                    images = decoded.map { it.first }
                    decoded.forEach { (_, bitmap) -> previews.addView(ImageView(this).apply { setImageBitmap(bitmap); scaleType = ImageView.ScaleType.CENTER_CROP; clipToOutline = true; background = shape(Color.LTGRAY,8) },LinearLayout.LayoutParams(dp(52),dp(52)).apply { marginEnd = dp(4) }) }
                    updateSend()
                }
            } catch (_: Exception) { ui { imageError = true; status.text = "No se pudo leer alguna imagen. Vuelve a compartirla desde la galería." } }
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
        loading = true; sendError = false
        status.text = if (sessions.isEmpty()) "Conectando con tus hosts…" else "Chats recientes · Actualizando…"
        val prefs = getSharedPreferences("share-targets",0)
        val servers = runCatching { ShareClient.servers(prefs.getString("config", "{}")!!) }.getOrElse { emptyList() }
        if (servers.isEmpty()) { loading = false; status.text = "Abre Codiby Code para sincronizar tus chats."; return }
        var pending = servers.size
        val failed = mutableListOf<String>()
        servers.forEach { server -> worker.execute {
            val result = runCatching { ShareClient.sessions(server) }
            ui {
                result.onSuccess { found ->
                    val old = sessions.filter { it.server.id == server.id }.associateBy { it.id }
                    sessions.removeAll { it.server.id == server.id }
                    sessions.addAll(found.map { it.copy(pinned = old[it.id]?.pinned ?: false, preview = old[it.id]?.preview.orEmpty(), pinOrder = old[it.id]?.pinOrder ?: -1) })
                    freshHosts.add(server.id)
                    selected = selected?.let { chosen -> sessions.find { key(it) == key(chosen) } }
                    showSessions(search.text.toString())
                }.onFailure { failed.add(server.name) }
                pending--; loading = pending > 0
                if (!sending && !sendError && !imageError) status.text = when {
                    loading -> "${sessions.size} chats · Actualizando…"
                    failed.isNotEmpty() -> "Sin conexión: ${failed.joinToString()} · Toca para reintentar"
                    sessions.isEmpty() -> "No hay chats activos en tus hosts."
                    else -> "Chats recientes"
                }
                updateSend()
            }
        } }
    }

    private fun showSessions(query: String) {
        filtered = sessions.filter { "${it.name} ${it.folder} ${it.server.name}".contains(query, ignoreCase = true) }
            .sortedWith(compareByDescending<ShareSession> { it.pinned }.thenByDescending { it.pinOrder }.thenByDescending { it.updated })
        adapter.notifyDataSetChanged(); updateSend()
    }

    private fun updateSend() {
        send.isEnabled = selected?.let { chosen -> filtered.any { key(it) == key(chosen) } } == true && images.isNotEmpty() && !sending
        send.alpha = if (send.isEnabled) 1f else 0.35f
        cancel.isEnabled = !sending
        destination.text = if (sending) "Enviando…" else selected?.name ?: "Elige un chat para continuar"
    }

    private fun submit() {
        val target = selected ?: return
        if (sending || images.isEmpty()) return
        sending = true; sendError = false; updateSend(); list.isEnabled = false; message.isEnabled = false; search.isEnabled = false
        val text = message.text.toString().take(8000)
        val isFresh = target.server.id in freshHosts
        worker.execute {
            try {
                // La foto permite elegir al instante; una lectura valida la ruta antes de escribir.
                val liveTarget = if (isFresh) target else ShareClient.sessions(target.server).firstOrNull { it.id == target.id }
                    ?: error("El chat ya no está activo")
                ShareClient.send(liveTarget, text, images)
                ui { Toast.makeText(this, "Enviado a ${target.name}", Toast.LENGTH_SHORT).show(); finish() }
            } catch (_: Exception) {
                ui {
                    sending = false; sendError = true; updateSend(); list.isEnabled = true; message.isEnabled = true; search.isEnabled = true
                    status.text = "No se confirmó el envío. Revisa el chat antes de reintentar."
                }
            }
        }
    }

    override fun onDestroy() { worker.shutdownNow(); decoder.shutdownNow(); super.onDestroy() }
}
