package com.example.attendance

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.tasks.await

object Locations {
    /** One fresh, high-accuracy fix. Location permission must already be granted. */
    @SuppressLint("MissingPermission")
    suspend fun current(ctx: Context): Location? = try {
        LocationServices.getFusedLocationProviderClient(ctx)
            .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, CancellationTokenSource().token)
            .await()
    } catch (e: Exception) {
        null
    }
}
