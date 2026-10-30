package com.example.attendance

import android.content.Context
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest
import kotlinx.coroutines.tasks.await
import java.security.MessageDigest
import java.util.Base64

object Integrity {
    /**
     * Must produce exactly what the server's nonceFor() produces: SHA-256 of the
     * parts joined with "|", URL-safe base64 without padding. Binding the request
     * values into the nonce means a captured token can't be replayed with
     * different coordinates.
     */
    fun nonceFor(parts: List<String>): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(parts.joinToString("|").toByteArray())
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }

    /** One trip point as it goes into the nonce. Must match pointKey in the server's lib.js. */
    fun pointKey(t: Long, latE6: Long, lngE6: Long, acc: Int, mock: Boolean): String =
        "$t,$latE6,$lngE6,$acc,${if (mock) 1 else 0}"

    /** Returns a Play Integrity token, or null if Google Play couldn't provide one. */
    suspend fun token(ctx: Context, nonce: String): String? = try {
        IntegrityManagerFactory.create(ctx.applicationContext)
            .requestIntegrityToken(
                IntegrityTokenRequest.builder()
                    .setNonce(nonce)
                    .setCloudProjectNumber(BuildConfig.CLOUD_PROJECT_NUMBER)
                    .build()
            ).await().token()
    } catch (e: Exception) {
        null
    }
}
