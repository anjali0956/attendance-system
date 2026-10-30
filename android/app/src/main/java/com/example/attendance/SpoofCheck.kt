package com.example.attendance

import android.location.Location
import android.os.Build
import android.os.SystemClock

object SpoofCheck {
    /** True if Android says this fix came from a mock location provider. */
    fun isMock(loc: Location): Boolean =
        if (Build.VERSION.SDK_INT >= 31) loc.isMock
        else @Suppress("DEPRECATION") loc.isFromMockProvider

    /** A message for the employee if this fix must not be used, otherwise null. */
    fun problem(loc: Location): String? {
        if (isMock(loc)) return "Your phone reports a mock location. Turn off any fake-GPS app and try again."
        val ageMs = (SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos) / 1_000_000
        if (ageMs > 15_000) return "Your location is out of date. Try again."
        if (loc.accuracy > 150f) return "Your location is too imprecise (±${loc.accuracy.toInt()} m). Move near a window and try again."
        return null
    }
}
