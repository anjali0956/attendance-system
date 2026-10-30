package com.example.attendance

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Records the employee's position while they are clocked in and uploads it to
 * the server every few minutes. Each upload carries a Play Integrity token.
 */
class TrackingService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var fused: FusedLocationProviderClient
    private val buffer = ArrayList<JSONObject>()
    private val uploadLock = Mutex()
    private var running = false

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            for (l in result.locations) {
                if (l.accuracy > 150f) continue
                buffer.add(
                    JSONObject()
                        .put("t", l.time)
                        .put("latE6", Math.round(l.latitude * 1e6))
                        .put("lngE6", Math.round(l.longitude * 1e6))
                        .put("acc", l.accuracy.roundToInt())
                        .put("mock", SpoofCheck.isMock(l))
                )
                if (buffer.size > 2000) buffer.removeAt(0)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    @SuppressLint("MissingPermission")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            scope.launch {
                fused.removeLocationUpdates(callback)
                running = false
                upload()
                stopSelf()
            }
            return START_NOT_STICKY
        }
        startInForeground()
        if (!running) {
            running = true
            val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 30_000)
                .setMinUpdateIntervalMillis(15_000)
                .build()
            fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
            scope.launch {
                while (isActive) {
                    delay(5 * 60_000L)
                    upload()
                }
            }
        }
        // Not sticky: Android 12+ blocks restarting a location service from the background.
        // The app resumes tracking the next time the employee opens it.
        return START_NOT_STICKY
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Trip tracking", NotificationManager.IMPORTANCE_LOW))
        val open = android.app.PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            android.app.PendingIntent.FLAG_IMMUTABLE
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Clocked in")
            .setContentText("Your location is being recorded while you work.")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(
            this, 1, n,
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
        )
    }

    /** Sends buffered points in batches. On any failure the rest stay buffered for the next try. */
    private suspend fun upload(): Unit = uploadLock.withLock {
        val token = Prefs(this).token ?: return@withLock
        while (buffer.isNotEmpty()) {
            val batch = buffer.take(MAX_BATCH)
            try {
                val nonce = Api.io { Api.nonce(token) }.getString("nonce")
                val keys = batch.map {
                    Integrity.pointKey(it.getLong("t"), it.getLong("latE6"), it.getLong("lngE6"), it.getInt("acc"), it.getBoolean("mock"))
                }
                val integrity = Integrity.token(this, Integrity.nonceFor(listOf(nonce, "track") + keys))
                val arr = JSONArray()
                batch.forEach { arr.put(it) }
                val body = JSONObject()
                    .put("serverNonce", nonce)
                    .put("integrityToken", integrity ?: "")
                    .put("points", arr)
                Api.io { Api.track(token, body) }
                buffer.removeAll(batch.toSet())
            } catch (e: Exception) {
                // Keep the points and retry on the next cycle.
                return@withLock
            }
        }
    }

    override fun onDestroy() {
        fused.removeLocationUpdates(callback)
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "com.example.attendance.STOP"
        private const val CHANNEL = "tracking"
        private const val MAX_BATCH = 200 // the most the server accepts in one upload
    }
}
