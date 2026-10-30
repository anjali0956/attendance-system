package com.example.attendance

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var message: TextView
    private lateinit var codeField: EditText
    private lateinit var enrollBtn: Button
    private lateinit var clockBtn: Button
    private var clockedIn = false
    private var afterPermission: (() -> Unit)? = null

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants[Manifest.permission.ACCESS_FINE_LOCATION] == true) afterPermission?.invoke()
            else say("Location permission is required to clock in and out.")
            afterPermission = null
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
        enrollBtn.setOnClickListener { enroll() }
        clockBtn.setOnClickListener { withPermissions { clock() } }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun say(text: String?) { message.text = text.orEmpty() }

    private fun withPermissions(then: () -> Unit) {
        val needed = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = needed.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) then()
        else { afterPermission = then; permissionLauncher.launch(missing.toTypedArray()) }
    }

    private fun render() {
        val enrolled = prefs.token != null
        codeField.visibility = if (enrolled) View.GONE else View.VISIBLE
        enrollBtn.visibility = if (enrolled) View.GONE else View.VISIBLE
        clockBtn.visibility = if (enrolled) View.VISIBLE else View.GONE
        status.text = when {
            !enrolled -> "Enter the code your manager gave you."
            clockedIn -> "${prefs.name}, you are clocked in."
            else -> "${prefs.name}, you are not clocked in."
        }
        clockBtn.text = if (clockedIn) "Clock out" else "Clock in"
    }

    private fun refresh() {
        render()
        val token = prefs.token ?: return
        lifecycleScope.launch {
            try {
                val me = Api.io { Api.me(token) }
                clockedIn = me.getBoolean("clockedIn")
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

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun enroll() {
        val code = codeField.text.toString().trim()
        if (code.length != 8) { say("Enter the 8-digit code."); return }
        enrollBtn.isEnabled = false
        lifecycleScope.launch {
            try {
                val r = Api.io { Api.enroll(code) }
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

    private fun clock() {
        val token = prefs.token ?: return
        val action = if (clockedIn) "out" else "in"
        clockBtn.isEnabled = false
        lifecycleScope.launch {
            try {
                say("Getting your location…")
                val loc = Locations.current(this@MainActivity)
                    ?: throw ApiException("Couldn't get your location. Turn on GPS and try again.")
                // A mock location still goes to the server, which refuses it and tells the manager.
                val mock = SpoofCheck.isMock(loc)
                if (!mock) SpoofCheck.problem(loc)?.let { throw ApiException(it) }

                val latE6 = Math.round(loc.latitude * 1e6)
                val lngE6 = Math.round(loc.longitude * 1e6)
                val acc = loc.accuracy.roundToInt()

                say("Verifying your phone…")
                val nonce = Api.io { Api.nonce(token) }.getString("nonce")
                val integrity = if (mock) null else Integrity.token(
                    this@MainActivity,
                    Integrity.nonceFor(listOf(nonce, action, latE6.toString(), lngE6.toString(), acc.toString()))
                )
                val body = JSONObject()
                    .put("action", action)
                    .put("latE6", latE6)
                    .put("lngE6", lngE6)
                    .put("acc", acc)
                    .put("mock", mock)
                    .put("serverNonce", nonce)
                    .put("integrityToken", integrity ?: "")
                val r = Api.io { Api.clock(token, body) }

                clockedIn = action == "in"
                if (clockedIn) startTracking() else stopTracking()
                render()
                say(r.optString("message"))
            } catch (e: ApiException) {
                say(e.message)
            } catch (e: Exception) {
                say("Something went wrong. Check your connection and try again.")
            } finally {
                clockBtn.isEnabled = true
            }
        }
    }

    private fun startTracking() =
        ContextCompat.startForegroundService(this, Intent(this, TrackingService::class.java))

    private fun stopTracking() =
        startService(Intent(this, TrackingService::class.java).setAction(TrackingService.ACTION_STOP))
}
