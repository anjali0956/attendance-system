package com.example.attendance

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** An error whose message is safe to show to the employee. */
class ApiException(message: String) : Exception(message)

object Api {
    private val client = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()
    private val json = "application/json".toMediaType()

    private fun call(path: String, token: String?, body: JSONObject?): JSONObject {
        val b = Request.Builder().url(BuildConfig.SERVER_URL + path)
        if (token != null) b.header("Authorization", "Bearer $token")
        if (body != null) b.post(body.toString().toRequestBody(json)) else b.get()
        client.newCall(b.build()).execute().use { r ->
            val text = r.body?.string().orEmpty()
            val parsed = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (!r.isSuccessful) throw ApiException(parsed.optString("error", "Server error (${r.code})"))
            return parsed
        }
    }

    suspend fun <T> io(f: () -> T): T = withContext(Dispatchers.IO) { f() }

    fun enroll(code: String) = call("/api/enroll", null, JSONObject().put("code", code))
    fun me(token: String) = call("/api/me", token, null)
    fun nonce(token: String) = call("/api/nonce", token, null)
    fun clock(token: String, body: JSONObject) = call("/api/clock", token, body)
    fun track(token: String, body: JSONObject) = call("/api/track", token, body)
}
