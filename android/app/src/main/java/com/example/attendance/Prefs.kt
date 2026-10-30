package com.example.attendance

import android.content.Context

class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("attendance", Context.MODE_PRIVATE)

    var token: String?
        get() = sp.getString("token", null)
        set(v) = sp.edit().putString("token", v).apply()

    var name: String?
        get() = sp.getString("name", null)
        set(v) = sp.edit().putString("name", v).apply()
}
