package com.example.attendance

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Bundle
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Takes a selfie with the front camera inside the app, so it can't be swapped
 * for a photo from the gallery. The JPEG is left in [file] for MainActivity.
 */
class SelfieActivity : AppCompatActivity() {
    private lateinit var take: Button
    private var capture: ImageCapture? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_selfie)
        take = findViewById(R.id.take)
        take.isEnabled = false
        take.setOnClickListener { snap() }
        val preview = findViewById<PreviewView>(R.id.preview)
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                val p = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                val c = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, p, c)
                capture = c
                take.isEnabled = true
            } catch (e: Exception) {
                fail("This phone's front camera couldn't be opened.")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun snap() {
        val c = capture ?: return
        take.isEnabled = false
        c.takePicture(ContextCompat.getMainExecutor(this), object : ImageCapture.OnImageCapturedCallback() {
            override fun onCaptureSuccess(image: ImageProxy) {
                try {
                    file(this@SelfieActivity).writeBytes(toJpeg(image.toBitmap(), image.imageInfo.rotationDegrees))
                    setResult(RESULT_OK)
                    finish()
                } catch (e: Exception) {
                    fail("The photo couldn't be saved. Try again.")
                } finally {
                    image.close()
                }
            }

            override fun onError(e: ImageCaptureException) {
                fail("The photo couldn't be taken. Try again.")
            }
        })
    }

    private fun fail(message: String) {
        setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, message))
        finish()
    }

    companion object {
        const val EXTRA_ERROR = "error"
        private const val MAX_SIDE = 640 // big enough to recognise a face, small enough to upload quickly

        fun file(ctx: android.content.Context) = File(ctx.cacheDir, "selfie.jpg")

        /** Turns the photo upright and shrinks it to a small JPEG. */
        fun toJpeg(src: Bitmap, rotationDegrees: Int): ByteArray {
            val scale = minOf(1f, MAX_SIDE.toFloat() / maxOf(src.width, src.height))
            val m = Matrix().apply { postScale(scale, scale); postRotate(rotationDegrees.toFloat()) }
            val upright = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
            return ByteArrayOutputStream().also { upright.compress(Bitmap.CompressFormat.JPEG, 75, it) }.toByteArray()
        }
    }
}
