package com.example.attendance

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Base64
import java.util.Date
import kotlin.coroutines.resume
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var message: TextView
    private lateinit var codeField: EditText
    private lateinit var enrollBtn: Button
    private lateinit var clockBtn: Button
    private lateinit var visitStatus: TextView
    private lateinit var visitBtn: Button
    private var clockedIn = false
    private var visit: JSONObject? = null // the customer visit in progress, as the server describes it
    private var afterPermission: (() -> Unit)? = null

    private class Fix(val latE6: Long, val lngE6: Long, val acc: Int, val mock: Boolean)
    private class Choice(val id: Long?, val name: String, val place: String)

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            if (has(Manifest.permission.ACCESS_FINE_LOCATION) && has(Manifest.permission.CAMERA)) afterPermission?.invoke()
            else say("Precise location and camera permission are required to clock in and out.")
            afterPermission = null
        }

    private val selfieLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            val file = SelfieActivity.file(this)
            if (r.resultCode == RESULT_OK && file.exists()) {
                val photo = file.readBytes()
                file.delete()
                clock(photo)
            } else {
                say(r.data?.getStringExtra(SelfieActivity.EXTRA_ERROR) ?: "A selfie is needed to clock in and out.")
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        status = findViewById(R.id.status)
        message = findViewById(R.id.message)
        codeField = findViewById(R.id.code)
        enrollBtn = findViewById(R.id.enroll)
        clockBtn = findViewById(R.id.clock)
        visitStatus = findViewById(R.id.visitStatus)
        visitBtn = findViewById(R.id.visit)
        enrollBtn.setOnClickListener { enroll() }
        clockBtn.setOnClickListener {
            withPermissions { selfieLauncher.launch(Intent(this, SelfieActivity::class.java)) }
        }
        visitBtn.setOnClickListener { withPermissions { if (visit == null) startVisit() else endVisit() } }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun say(text: String?) { message.text = text.orEmpty() }

    private fun withPermissions(then: () -> Unit) {
        val needed = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = needed.filter { !has(it) }
        if (missing.isEmpty()) then()
        else { afterPermission = then; permissionLauncher.launch(missing.toTypedArray()) }
    }

    private fun render() {
        val enrolled = prefs.token != null
        val v = visit
        codeField.visibility = if (enrolled) View.GONE else View.VISIBLE
        enrollBtn.visibility = if (enrolled) View.GONE else View.VISIBLE
        clockBtn.visibility = if (enrolled) View.VISIBLE else View.GONE
        status.text = when {
            !enrolled -> "Enter the code your manager gave you."
            clockedIn -> "${prefs.name}, you are clocked in."
            else -> "${prefs.name}, you are not clocked in."
        }
        clockBtn.text = if (clockedIn) "Clock out" else "Clock in"
        visitBtn.visibility = if (enrolled && clockedIn) View.VISIBLE else View.GONE
        visitBtn.text = if (v != null) "End visit" else "Start customer visit"
        visitStatus.visibility = if (enrolled && clockedIn && v != null) View.VISIBLE else View.GONE
        if (v != null) {
            val since = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(v.getLong("startAt")))
            visitStatus.text = "Visiting ${v.getString("customer")}, ${v.getString("place")} since $since"
        }
    }

    private fun refresh() {
        render()
        val token = prefs.token ?: return
        lifecycleScope.launch {
            try {
                val me = Api.io { Api.me(token) }
                clockedIn = me.getBoolean("clockedIn")
                visit = me.optJSONObject("visit")
                prefs.name = me.getString("name")
                render()
                // The reply may arrive after the employee has left the app. Android refuses to start tracking then.
                val visible = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
                if (clockedIn && visible && hasLocationPermission()) startTracking()
            } catch (e: ApiException) {
                if (e.message?.contains("not signed in") == true) { prefs.token = null; render() }
                say(e.message)
            } catch (e: Exception) {
                say("Can't reach the server. Check your connection.")
            }
        }
    }

    private fun has(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun hasLocationPermission() = has(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun enroll() {
        val code = codeField.text.toString().trim()
        if (code.length != 8) { say("Enter the 8-digit code."); return }
        enrollBtn.isEnabled = false
        lifecycleScope.launch {
            try {
                val r = Api.io { Api.enroll(code, "${Build.MANUFACTURER} ${Build.MODEL}") }
                prefs.token = r.getString("token")
                prefs.name = r.getString("name")
                say("This phone is enrolled.")
                refresh()
            } catch (e: ApiException) {
                say(e.message)
            } catch (e: Exception) {
                say("Can't reach the server. Check your connection.")
            } finally {
                enrollBtn.isEnabled = true
            }
        }
    }

    /** Runs one action with the buttons disabled, showing any error to the employee. */
    private fun busy(work: suspend () -> Unit) {
        clockBtn.isEnabled = false
        visitBtn.isEnabled = false
        lifecycleScope.launch {
            try {
                work()
            } catch (e: ApiException) {
                say(e.message)
            } catch (e: Exception) {
                say("Something went wrong. Check your connection and try again.")
            } finally {
                clockBtn.isEnabled = true
                visitBtn.isEnabled = true
            }
        }
    }

    /** One fresh GPS reading. A mock location is still returned, so the server can refuse it and tell the manager. */
    private suspend fun fix(): Fix {
        say("Getting your location…")
        val loc = Locations.current(this)
            ?: throw ApiException("Couldn't get your location. Turn on GPS and try again.")
        val mock = SpoofCheck.isMock(loc)
        if (!mock) SpoofCheck.problem(loc)?.let { throw ApiException(it) }
        return Fix(Math.round(loc.latitude * 1e6), Math.round(loc.longitude * 1e6), loc.accuracy.roundToInt(), mock)
    }

    /**
     * Sends a request carrying the employee's position, protected by a one-time server nonce and Play Integrity.
     * extra: the request's other values, in the order the server puts them in its nonce.
     */
    private suspend fun signed(
        token: String, action: String, fix: Fix, extra: List<String>, body: JSONObject,
        send: (String, JSONObject) -> JSONObject
    ): JSONObject {
        say("Verifying your phone…")
        val nonce = Api.io { Api.nonce(token) }.getString("nonce")
        val parts = listOf(nonce, action, fix.latE6.toString(), fix.lngE6.toString(), fix.acc.toString()) + extra
        val integrity = if (fix.mock) null else Integrity.token(this, Integrity.nonceFor(parts))
        body.put("latE6", fix.latE6).put("lngE6", fix.lngE6).put("acc", fix.acc).put("mock", fix.mock)
            .put("serverNonce", nonce).put("integrityToken", integrity ?: "")
        return Api.io { send(token, body) }
    }

    private fun clock(photo: ByteArray) {
        val token = prefs.token ?: return
        val action = if (clockedIn) "out" else "in"
        val photoB64 = Base64.getEncoder().encodeToString(photo)
        busy {
            val r = signed(token, action, fix(), listOf(photoB64), JSONObject().put("action", action).put("photo", photoB64), Api::clock)
            clockedIn = action == "in"
            if (!clockedIn) visit = null // clocking out ends any visit
            if (clockedIn) startTracking() else stopTracking()
            render()
            say(r.optString("message"))
        }
    }

    private fun startVisit() {
        val token = prefs.token ?: return
        busy {
            val here = fix()
            val nearby = Api.io { Api.customers(token, here.latE6, here.lngE6) }.getJSONArray("customers")
            say("")
            val choice = chooseCustomer(nearby) ?: return@busy
            // A fresh reading, in case choosing took a while.
            val body = JSONObject()
            val extra = if (choice.id != null) {
                body.put("customerId", choice.id)
                listOf(choice.id.toString(), "", "")
            } else {
                body.put("name", choice.name).put("place", choice.place)
                listOf("", choice.name, choice.place)
            }
            val r = signed(token, "visit_start", fix(), extra, body, Api::visitStart)
            visit = r.getJSONObject("visit")
            render()
            say(r.optString("message"))
        }
    }

    private fun endVisit() {
        val token = prefs.token ?: return
        busy {
            val r = signed(token, "visit_end", fix(), emptyList(), JSONObject(), Api::visitEnd)
            visit = null
            render()
            say(r.optString("message"))
        }
    }

    /** Asks which customer this is: one nearby (closest first), or a new one. Null if the employee cancels. */
    private suspend fun chooseCustomer(nearby: JSONArray): Choice? = suspendCancellableCoroutine { cont ->
        var done = false
        val finish = { c: Choice? -> if (!done) { done = true; cont.resume(c) } }
        val labels = (0 until nearby.length()).map {
            val c = nearby.getJSONObject(it)
            val d = c.getInt("distM")
            "${c.getString("name")}, ${c.getString("place")} (" + (if (d < 1000) "$d m" else "%.1f km".format(d / 1000.0)) + ")"
        }
        AlertDialog.Builder(this)
            .setTitle("Which customer are you visiting?")
            .setItems((listOf("+ New customer") + labels).toTypedArray()) { _, i ->
                if (i == 0) newCustomer(finish)
                else nearby.getJSONObject(i - 1).let { finish(Choice(it.getLong("id"), it.getString("name"), it.getString("place"))) }
            }
            .setOnCancelListener { finish(null) }
            .show()
    }

    private fun newCustomer(finish: (Choice?) -> Unit) {
        val words = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
        val name = EditText(this).apply { hint = "Customer name"; inputType = words }
        val place = EditText(this).apply { hint = "Place"; inputType = words }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(64, 16, 64, 0)
            addView(name)
            addView(place)
        }
        AlertDialog.Builder(this)
            .setTitle("New customer")
            .setMessage("Your current location will be saved as this customer's location.")
            .setView(box)
            .setPositiveButton("Start visit") { _, _ ->
                val n = name.text.toString().trim()
                val p = place.text.toString().trim()
                if (n.isEmpty() || p.isEmpty()) { say("Enter the customer's name and place."); finish(null) }
                else finish(Choice(null, n, p))
            }
            .setNegativeButton("Cancel") { _, _ -> finish(null) }
            .setOnCancelListener { finish(null) }
            .show()
    }

    private fun startTracking() =
        ContextCompat.startForegroundService(this, Intent(this, TrackingService::class.java))

    private fun stopTracking() =
        startService(Intent(this, TrackingService::class.java).setAction(TrackingService.ACTION_STOP))
}
