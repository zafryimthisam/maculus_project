package com.maculusapp

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.io.File
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * Captures individual JPEG frames from the phone camera for the existing
 * JavaScript YOLO/depth pipeline. No images are persisted: CameraX writes to a
 * private cache file, which is deleted immediately after the bytes are read.
 */
class MaculusDeviceCameraModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), PermissionListener, LifecycleEventListener {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val frameCounter = AtomicLong(0)

    @Volatile private var cameraProvider: ProcessCameraProvider? = null
    @Volatile private var imageCapture: ImageCapture? = null
    @Volatile private var lensFacing = "back"
    private var pendingStartPromise: Promise? = null

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun startCamera(promise: Promise) {
        mainHandler.post {
            if (imageCapture != null) {
                promise.resolve(startResult(alreadyStarted = true))
                return@post
            }
            if (!hasCameraPermission()) {
                requestCameraPermission(promise)
                return@post
            }
            bindCamera(promise)
        }
    }

    @ReactMethod
    fun captureFrame(promise: Promise) {
        val capture = imageCapture
        if (capture == null) {
            promise.reject("DEVICE_CAMERA_NOT_STARTED", "Phone camera is not started")
            return
        }

        val outputFile = try {
            File.createTempFile("maculus-device-frame-", ".jpg", reactContext.cacheDir)
        } catch (e: Exception) {
            promise.reject("DEVICE_CAMERA_FILE_ERROR", e.message, e)
            return
        }
        val outputOptions = ImageCapture.OutputFileOptions.Builder(outputFile).build()
        capture.takePicture(
            outputOptions,
            cameraExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    try {
                        val frame = normalizedJpeg(outputFile)
                        promise.resolve(Arguments.createMap().apply {
                            putString("base64", Base64.encodeToString(frame.bytes, Base64.NO_WRAP))
                            putDouble("frameId", frameCounter.incrementAndGet().toDouble())
                            putDouble("capturedAt", System.currentTimeMillis().toDouble())
                            if (frame.resolution != null) {
                                putString("resolution", frame.resolution)
                            } else {
                                putNull("resolution")
                            }
                            putString("lensFacing", lensFacing)
                        })
                    } catch (e: Exception) {
                        promise.reject("DEVICE_CAMERA_READ_ERROR", e.message, e)
                    } finally {
                        outputFile.delete()
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    outputFile.delete()
                    promise.reject("DEVICE_CAMERA_CAPTURE_ERROR", exception.message, exception)
                }
            }
        )
    }

    @ReactMethod
    fun stopCamera(promise: Promise) {
        mainHandler.post {
            unbindCamera()
            promise.resolve(null)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ): Boolean {
        if (requestCode != REQUEST_CAMERA_PERMISSION) return false

        val promise = pendingStartPromise
        pendingStartPromise = null
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        mainHandler.post {
            if (!granted) {
                promise?.reject(
                    "DEVICE_CAMERA_PERMISSION_DENIED",
                    "Camera permission is needed when the Raspberry Pi camera is unavailable"
                )
            } else if (promise != null) {
                bindCamera(promise)
            }
        }
        return true
    }

    override fun onHostResume() = Unit

    override fun onHostPause() = Unit

    override fun onHostDestroy() {
        mainHandler.post { unbindCamera() }
        cameraExecutor.shutdown()
        reactContext.removeLifecycleEventListener(this)
    }

    private fun bindCamera(promise: Promise) {
        val activity = currentActivity
        if (activity !is LifecycleOwner) {
            promise.reject("DEVICE_CAMERA_NO_ACTIVITY", "No lifecycle-aware activity is available")
            return
        }
        if (!reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            promise.reject("DEVICE_CAMERA_UNAVAILABLE", "This device has no camera")
            return
        }

        val providerFuture = ProcessCameraProvider.getInstance(reactContext)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                val selector = when {
                    provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> {
                        lensFacing = "back"
                        CameraSelector.DEFAULT_BACK_CAMERA
                    }
                    provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> {
                        lensFacing = "front"
                        CameraSelector.DEFAULT_FRONT_CAMERA
                    }
                    else -> throw IllegalStateException("This device has no usable camera")
                }
                val resolutionSelector = ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            Size(TARGET_WIDTH, TARGET_HEIGHT),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                        )
                    )
                    .build()
                val capture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .setResolutionSelector(resolutionSelector)
                    .build()

                provider.unbindAll()
                provider.bindToLifecycle(activity, selector, capture)
                cameraProvider = provider
                imageCapture = capture
                promise.resolve(startResult(alreadyStarted = false))
            } catch (e: Exception) {
                imageCapture = null
                cameraProvider = null
                promise.reject("DEVICE_CAMERA_START_ERROR", e.message, e)
            }
        }, ContextCompat.getMainExecutor(reactContext))
    }

    private fun unbindCamera() {
        val capture = imageCapture
        imageCapture = null
        if (capture != null) {
            try {
                cameraProvider?.unbind(capture)
            } catch (_: Exception) {
                // The lifecycle may already have released CameraX.
            }
        }
        cameraProvider = null
    }

    private fun requestCameraPermission(promise: Promise) {
        val activity = currentActivity
        if (activity !is PermissionAwareActivity) {
            promise.reject("DEVICE_CAMERA_NO_ACTIVITY", "Cannot request camera permission")
            return
        }
        if (pendingStartPromise != null) {
            promise.reject("DEVICE_CAMERA_START_PENDING", "A camera permission request is already active")
            return
        }
        pendingStartPromise = promise
        activity.requestPermissions(
            arrayOf(Manifest.permission.CAMERA),
            REQUEST_CAMERA_PERMISSION,
            this
        )
    }

    private fun hasCameraPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            reactContext.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private data class EncodedFrame(val bytes: ByteArray, val resolution: String?)

    private fun normalizedJpeg(file: File): EncodedFrame {
        val original = file.readBytes()
        val orientation = try {
            ExifInterface(file).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            )
        } catch (_: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
        val needsTransform = orientation != ExifInterface.ORIENTATION_NORMAL &&
            orientation != ExifInterface.ORIENTATION_UNDEFINED
        if (!needsTransform) {
            val dimensions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(original, 0, original.size, dimensions)
            val resolution = if (dimensions.outWidth > 0 && dimensions.outHeight > 0) {
                "${dimensions.outWidth}x${dimensions.outHeight}"
            } else {
                null
            }
            return EncodedFrame(original, resolution)
        }

        val bitmap = BitmapFactory.decodeByteArray(original, 0, original.size)
            ?: return EncodedFrame(original, null)
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                    setRotate(180f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_TRANSPOSE -> {
                    setRotate(90f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> {
                    setRotate(-90f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
        val normalized = try {
            android.graphics.Bitmap.createBitmap(
                bitmap,
                0,
                0,
                bitmap.width,
                bitmap.height,
                matrix,
                true
            )
        } catch (_: Exception) {
            bitmap.recycle()
            return EncodedFrame(original, null)
        }
        val output = ByteArrayOutputStream()
        normalized.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, output)
        val bytes = output.toByteArray()
        val resolution = "${normalized.width}x${normalized.height}"
        if (normalized !== bitmap) normalized.recycle()
        bitmap.recycle()
        return EncodedFrame(bytes, resolution)
    }

    private fun startResult(alreadyStarted: Boolean) = Arguments.createMap().apply {
        putBoolean("started", true)
        putBoolean("alreadyStarted", alreadyStarted)
        putString("lensFacing", lensFacing)
    }

    companion object {
        private const val NAME = "MaculusDeviceCamera"
        private const val REQUEST_CAMERA_PERMISSION = 4108
        private const val TARGET_WIDTH = 640
        private const val TARGET_HEIGHT = 480
    }
}
