package com.mojojojoo.sosifyapp

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.UUID

/**
 * Native Android BLE Peripheral Advertising module for React Native.
 *
 * Provides BLE peripheral mode (advertising) to the JavaScript layer via
 * NativeModules.BleAdvertiser. This is necessary because react-native-ble-plx
 * only supports the Central role (scanning/connecting).
 *
 * Broadcasts the custom 25-byte manufacturer data payload (device_id + role +
 * public_key_hash + timestamp) as defined in TRANSPORT.md.
 *
 * Requires BLUETOOTH_ADVERTISE permission on Android 12+ (API 31+).
 */
class BleAdvertiserModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        // Custom Service UUID for the Disaster P2P Application discovery channel
        private const val DISASTER_P2P_SERVICE_UUID = "550e8400-e29b-41d4-a716-446655440000"
        // BLE manufacturer ID (0xFFFF = test/development use)
        private const val MANUFACTURER_ID = 0xFFFF
    }

    private var bluetoothLeAdvertiser: BluetoothLeAdvertiser? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var isAdvertising = false

    override fun getName(): String = "BleAdvertiser"

    /**
     * Starts BLE peripheral advertising with the given 25-byte manufacturer data payload.
     *
     * @param payloadBase64 Base64-encoded 25-byte payload (device_id + role + pk_hash + timestamp)
     * @param localName     Human-readable device name shown in scan results
     * @param promise       Resolves on success, rejects on failure
     */
    @ReactMethod
    fun startAdvertising(payloadBase64: String, localName: String, promise: Promise) {
        if (isAdvertising) {
            promise.resolve(null)
            return
        }

        val bluetoothManager =
            reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val bluetoothAdapter = bluetoothManager?.adapter

        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled) {
            promise.reject("BLE_UNAVAILABLE", "Bluetooth adapter is not available or disabled.")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !bluetoothAdapter.isLeExtendedAdvertisingSupported &&
            !bluetoothAdapter.isMultipleAdvertisementSupported
        ) {
            promise.reject("BLE_ADVERTISE_UNSUPPORTED",
                "This device does not support BLE peripheral advertising.")
            return
        }

        bluetoothLeAdvertiser = bluetoothAdapter.bluetoothLeAdvertiser
        if (bluetoothLeAdvertiser == null) {
            promise.reject("BLE_ADVERTISER_NULL", "BluetoothLeAdvertiser is null.")
            return
        }

        // Decode the base64 payload
        val manufacturerData: ByteArray = try {
            android.util.Base64.decode(payloadBase64, android.util.Base64.DEFAULT)
        } catch (e: Exception) {
            promise.reject("BLE_PAYLOAD_DECODE_ERROR", "Failed to decode payload: ${e.message}")
            return
        }

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(false) // We use Wi-Fi Direct for the actual data channel
            .build()

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(UUID.fromString(DISASTER_P2P_SERVICE_UUID)))
            .build()

        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addManufacturerData(MANUFACTURER_ID, manufacturerData)
            .build()

        advertiseCallback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                isAdvertising = true
                promise.resolve(null)
            }
            override fun onStartFailure(errorCode: Int) {
                val reason = when (errorCode) {
                    ADVERTISE_FAILED_ALREADY_STARTED -> "ALREADY_STARTED"
                    ADVERTISE_FAILED_DATA_TOO_LARGE -> "DATA_TOO_LARGE"
                    ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "FEATURE_UNSUPPORTED"
                    ADVERTISE_FAILED_INTERNAL_ERROR -> "INTERNAL_ERROR"
                    ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "TOO_MANY_ADVERTISERS"
                    else -> "UNKNOWN_ERROR_$errorCode"
                }
                promise.reject("BLE_ADVERTISE_FAILED", reason)
            }
        }

        bluetoothLeAdvertiser?.startAdvertising(settings, data, scanResponse, advertiseCallback)
    }

    /**
     * Stops BLE peripheral advertising.
     */
    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        if (!isAdvertising) {
            promise.resolve(null)
            return
        }
        try {
            bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
            isAdvertising = false
            advertiseCallback = null
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("BLE_STOP_ADVERTISE_ERROR", e.message, e)
        }
    }

    /**
     * Returns whether this device supports BLE peripheral (advertising) mode.
     */
    @ReactMethod
    fun isAdvertisingSupported(promise: Promise) {
        val bluetoothManager =
            reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = bluetoothManager?.adapter
        val supported = adapter?.isMultipleAdvertisementSupported == true
        promise.resolve(supported)
    }

    // Required stubs for React Native EventEmitter compatibility
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
