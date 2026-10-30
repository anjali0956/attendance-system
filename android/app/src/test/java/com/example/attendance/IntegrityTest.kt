package com.example.attendance

import org.junit.Assert.assertEquals
import org.junit.Test

/** The same values are checked against the server's code in server/test.js. */
class IntegrityTest {
    @Test
    fun clockNonceMatchesServer() {
        assertEquals("1krGc6a0mkE9rbxXp5Znu39i9npaelZj8OaTxiK_f9I", Integrity.nonceFor(listOf("abc", "in", "10000000", "76000000", "12")))
    }

    @Test
    fun trackNonceMatchesServer() {
        val key = Integrity.pointKey(1700000000000L, 10000000L, -76000000L, 8, false)
        assertEquals("1700000000000,10000000,-76000000,8,0", key)
        assertEquals("mV774Uq6mKwJNbbmJ-EJIZCyaRuEnkTORxr43vW1O-Q", Integrity.nonceFor(listOf("abc", "track", key)))
    }
}
