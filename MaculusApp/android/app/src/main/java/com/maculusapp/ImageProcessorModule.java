package com.maculusapp;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.util.Base64;
import com.facebook.react.bridge.*;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public class ImageProcessorModule extends ReactContextBaseJavaModule {
    private static final int YOLO_SIZE = 640;
    private static final int SCENE_SIZE = 224;

    public ImageProcessorModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return "ImageProcessor";
    }

    @ReactMethod
    public void preprocessYOLO(String base64Image, Promise promise) {
        try {
            WritableMap result = preprocess(base64Image, YOLO_SIZE, true);
            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("PREPROCESS_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void preprocessScene(String base64Image, Promise promise) {
        try {
            WritableMap result = preprocess(base64Image, SCENE_SIZE, false);
            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("PREPROCESS_ERROR", e.getMessage());
        }
    }

    private WritableMap preprocess(String base64Image, int targetSize, boolean normalizeTo01) {
        byte[] decoded = Base64.decode(base64Image, Base64.DEFAULT);
        if (decoded == null || decoded.length == 0) {
            throw new IllegalArgumentException("Invalid base64 image data");
        }
        Bitmap original = BitmapFactory.decodeByteArray(decoded, 0, decoded.length);
        if (original == null) {
            throw new IllegalArgumentException("Failed to decode image bitmap");
        }

        Bitmap scaled = null;
        try {
            scaled = Bitmap.createScaledBitmap(original, targetSize, targetSize, true);
            if (scaled == null) {
                throw new IllegalArgumentException("Failed to scale image bitmap");
            }
            int[] pixels = new int[targetSize * targetSize];
            scaled.getPixels(pixels, 0, targetSize, 0, 0, targetSize, targetSize);

            ByteBuffer buffer = ByteBuffer.allocateDirect(targetSize * targetSize * 3 * 4);
            buffer.order(ByteOrder.nativeOrder());

            for (int i = 0; i < pixels.length; i++) {
                int pixel = pixels[i];
                float r = ((pixel >> 16) & 0xFF);
                float g = ((pixel >> 8) & 0xFF);
                float b = (pixel & 0xFF);

                if (normalizeTo01) {
                    r /= 255.0f;
                    g /= 255.0f;
                    b /= 255.0f;
                }

                buffer.putFloat(r);
                buffer.putFloat(g);
                buffer.putFloat(b);
            }

            byte[] outBytes = new byte[buffer.capacity()];
            buffer.rewind();
            buffer.get(outBytes);

            String outBase64 = Base64.encodeToString(outBytes, Base64.NO_WRAP);

            WritableMap map = Arguments.createMap();
            map.putString("base64", outBase64);
            map.putInt("width", targetSize);
            map.putInt("height", targetSize);
            return map;
        } finally {
            original.recycle();
            if (scaled != null) {
                scaled.recycle();
            }
        }
    }
}
