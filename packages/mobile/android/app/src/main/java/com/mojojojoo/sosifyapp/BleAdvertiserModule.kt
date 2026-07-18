package com.mojojojoo.sosifyapp

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Native Android BLE Peripheral Advertising module for React Native.
 *
 * Provides BLE peripheral mode (advertising) to the JavaScript layer via
 * NativeModules.BleAdvertiser. This is necessary because react-native-ble-plx
 * and react-native-ble-manager only support the Central role (scanning/connecting).
 *
 * Advertising strategy is tiered by hardware capability:
 *   1. BLE 5.0 Extended Advertising (up to 1650 bytes) — preferred, full payload
 *   2. Legacy BLE Advertising (31 bytes max) — trimmed payload
 *   3. Scan-only mode — device cannot advertise, but can still discover peers
 *
 * The 128-bit Service UUID has been removed from the advertising packet to save
 * 18 bytes. App identification is done via a 2-byte magic prefix (0xD2 0x50)
 * inside the manufacturer-specific data payload.
 *
 * Requires BLUETOOTH_ADVERTISE permission on Android 12+ (API 31+).
 */
class BleAdvertiserModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        // BLE manufacturer ID (0xFFFF = test/development use — do not ship to production)
        private const val MANUFACTURER_ID = 0xFFFF

        // Capability tier strings returned to JavaScript
        private const val CAPABILITY_EXTENDED = "extended"
        private const val CAPABILITY_LEGACY = "legacy"
        private const val CAPABILITY_TRIMMED = "trimmed"
        private const val CAPABILITY_SCAN_ONLY = "scan_only"
    }

    private var bluetoothLeAdvertiser: BluetoothLeAdvertiser? = null
    private var legacyAdvertiseCallback: AdvertiseCallback? = null
    private var extendedAdvertisingSet: AdvertisingSet? = null
    private var extendedCallback: AdvertisingSetCallback? = null
    private var isAdvertising = false
    private var currentCapability: String = CAPABILITY_SCAN_ONLY

    override fun getName(): String = "BleAdvertiser"

    /**
     * Starts BLE peripheral advertising with the given manufacturer data payload.
     *
     * The payload is provided in two sizes from the JS layer:
     * - payloadFullBase64:    Full payload (27 bytes): [magic:2][device_id:16][role:1][pk_hash:4][timestamp:4]
     * - payloadTrimmedBase64: Trimmed payload (23 bytes): [magic:2][device_id:16][role:1][pk_hash:2][timestamp:2]
     *
     * The module selects the appropriate payload size based on hardware capability:
     * - BLE 5.0 Extended → full payload (no size concern)
     * - Legacy BLE → trimmed payload (fits within 31-byte limit)
     *
     * Resolves with a WritableMap containing:
     *   { capability: "extended" | "legacy" | "trimmed" | "scan_only" }
     *
     * @param payloadFullBase64    Base64-encoded full payload (27 bytes with magic prefix)
     * @param payloadTrimmedBase64 Base64-encoded trimmed payload (23 bytes with magic prefix)
     * @param promise              Resolves with capability info, rejects on unrecoverable failure
     */
    @ReactMethod
    fun startAdvertising(payloadFullBase64: String, payloadTrimmedBase64: String, promise: Promise) {
        if (isAdvertising) {
            val result = Arguments.createMap()
            result.putString("capability", currentCapability)
            promise.resolve(result)
            return
        }

        val bluetoothManager =
            reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val bluetoothAdapter = bluetoothManager?.adapter

        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled) {
            promise.reject("BLE_UNAVAILABLE", "Bluetooth adapter is not available or disabled.")
            return
        }

        // Decode both payload variants
        val fullPayload: ByteArray = try {
            android.util.Base64.decode(payloadFullBase64, android.util.Base64.DEFAULT)
        } catch (e: Exception) {
            promise.reject("BLE_PAYLOAD_DECODE_ERROR", "Failed to decode full payload: ${e.message}")
            return
        }

        val trimmedPayload: ByteArray = try {
            android.util.Base64.decode(payloadTrimmedBase64, android.util.Base64.DEFAULT)
        } catch (e: Exception) {
            promise.reject("BLE_PAYLOAD_DECODE_ERROR", "Failed to decode trimmed payload: ${e.message}")
            return
        }

        // Check if device supports advertising at all
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !bluetoothAdapter.isMultipleAdvertisementSupported
        ) {
            // Device cannot advertise — degrade gracefully to scan-only mode
            currentCapability = CAPABILITY_SCAN_ONLY
            val result = Arguments.createMap()
            result.putString("capability", CAPABILITY_SCAN_ONLY)
            promise.resolve(result)
            return
        }

        // Tier 1: Try BLE 5.0 Extended Advertising (supports up to 1650 bytes)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            bluetoothAdapter.isLeExtendedAdvertisingSupported
        ) {
            tryExtendedAdvertising(bluetoothAdapter, fullPayload, trimmedPayload, promise)
            return
        }

        // Tier 2: Legacy BLE Advertising with trimmed payload
        bluetoothLeAdvertiser = bluetoothAdapter.bluetoothLeAdvertiser
        if (bluetoothLeAdvertiser == null) {
            promise.reject("BLE_ADVERTISER_NULL", "BluetoothLeAdvertiser is null.")
            return
        }

        tryLegacyAdvertising(trimmedPayload, CAPABILITY_LEGACY, promise)
    }

    /**
     * Attempts BLE 5.0 Extended Advertising with the full-size payload.
     * Extended advertising supports payloads up to 1650 bytes, so the full
     * 27-byte payload fits with enormous margin.
     */
    private fun tryExtendedAdvertising(
        bluetoothAdapter: BluetoothAdapter,
        payload: ByteArray,
        trimmedPayload: ByteArray,
        promise: Promise
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Shouldn't reach here, but guard against it
            promise.reject("BLE_EXTENDED_UNSUPPORTED", "Extended advertising requires API 26+.")
            return
        }

        val advertiser = bluetoothAdapter.bluetoothLeAdvertiser
        if (advertiser == null) {
            promise.reject("BLE_ADVERTISER_NULL", "BluetoothLeAdvertiser is null.")
            return
        }

        val parameters = AdvertisingSetParameters.Builder()
            .setLegacyMode(false) // Use extended mode
            .setConnectable(false) // We use Wi-Fi Direct for the actual data channel
            .setScannable(false)
            .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_MEDIUM)
            .setInterval(AdvertisingSetParameters.INTERVAL_LOW) // ~1.28s between advertisements
            .build()

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addManufacturerData(MANUFACTURER_ID, payload)
            .build()

        extendedCallback = object : AdvertisingSetCallback() {
            override fun onAdvertisingSetStarted(
                advertisingSet: AdvertisingSet?,
                txPower: Int,
                status: Int
            ) {
                if (status == AdvertisingSetCallback.ADVERTISE_SUCCESS) {
                    extendedAdvertisingSet = advertisingSet
                    isAdvertising = true
                    currentCapability = CAPABILITY_EXTENDED
                    val result = Arguments.createMap()
                    result.putString("capability", CAPABILITY_EXTENDED)
                    promise.resolve(result)
                } else {
                    // Extended advertising failed — this shouldn't normally happen since
                    // we already checked isLeExtendedAdvertisingSupported, but some OEM
                    // stacks are unreliable. Fall back to legacy.
                    bluetoothLeAdvertiser = bluetoothAdapter.bluetoothLeAdvertiser
                    if (bluetoothLeAdvertiser != null) {
                        // Use the correctly sized trimmed payload for legacy fallback
                        tryLegacyAdvertising(trimmedPayload, CAPABILITY_LEGACY, promise)
                    } else {
                        promise.reject("BLE_ADVERTISE_FAILED",
                            "Extended advertising failed (status=$status) and legacy advertiser unavailable.")
                    }
                }
            }

            override fun onAdvertisingSetStopped(advertisingSet: AdvertisingSet?) {
                isAdvertising = false
                extendedAdvertisingSet = null
            }
        }

        advertiser.startAdvertisingSet(parameters, data, null, null, null, extendedCallback!!)
    }

    /**
     * Attempts legacy BLE advertising with the given payload.
     *
     * Packet budget for legacy BLE (31 bytes max):
     *   - 3 bytes: Flags AD structure (auto-prepended by Android)
     *   - 1 byte:  Manufacturer Data AD length
     *   - 1 byte:  Manufacturer Data AD type (0xFF)
     *   - 2 bytes: Company Identifier (MANUFACTURER_ID)
     *   - N bytes: Manufacturer data payload
     *   Total overhead: 7 bytes → max payload = 24 bytes
     *
     * The trimmed payload is 23 bytes → total packet = 30/31 bytes (1 byte margin).
     *
     * If advertising fails with DATA_TOO_LARGE, the caller should retry with
     * an even smaller payload.
     */
    private fun tryLegacyAdvertising(
        payload: ByteArray,
        capabilityLabel: String,
        promise: Promise
    ) {
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(false) // We use Wi-Fi Direct for the actual data channel
            .build()

        // No service UUID — app identification is done via magic prefix in manufacturer data
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addManufacturerData(MANUFACTURER_ID, payload)
            .build()

        legacyAdvertiseCallback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                isAdvertising = true
                currentCapability = capabilityLabel
                val result = Arguments.createMap()
                result.putString("capability", capabilityLabel)
                promise.resolve(result)
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

        bluetoothLeAdvertiser?.startAdvertising(settings, data, legacyAdvertiseCallback)
    }

    /**
     * Stops BLE peripheral advertising (both extended and legacy).
     */
    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        if (!isAdvertising) {
            promise.resolve(null)
            return
        }
        try {
            // Stop extended advertising if active
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && extendedAdvertisingSet != null) {
                val advertiser = (reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)
                    ?.adapter?.bluetoothLeAdvertiser
                if (advertiser != null && extendedCallback != null) {
                    advertiser.stopAdvertisingSet(extendedCallback!!)
                }
                extendedAdvertisingSet = null
                extendedCallback = null
            }

            // Stop legacy advertising if active
            if (legacyAdvertiseCallback != null) {
                bluetoothLeAdvertiser?.stopAdvertising(legacyAdvertiseCallback)
                legacyAdvertiseCallback = null
            }

            isAdvertising = false
            currentCapability = CAPABILITY_SCAN_ONLY
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("BLE_STOP_ADVERTISE_ERROR", e.message, e)
        }
    }

    /**
     * Returns whether this device supports BLE peripheral (advertising) mode
     * and which tier is available.
     *
     * Resolves with a WritableMap:
     *   {
     *     canAdvertise: boolean,
     *     supportsExtended: boolean,
     *     isCurrentlyAdvertising: boolean,
     *     currentCapability: string
     *   }
     */
    @ReactMethod
    fun getAdvertisingCapabilities(promise: Promise) {
        val bluetoothManager =
            reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = bluetoothManager?.adapter

        val canAdvertise = adapter?.isMultipleAdvertisementSupported == true
        val supportsExtended = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            adapter?.isLeExtendedAdvertisingSupported == true
        } else {
            false
        }

        val result = Arguments.createMap()
        result.putBoolean("canAdvertise", canAdvertise)
        result.putBoolean("supportsExtended", supportsExtended)
        result.putBoolean("isCurrentlyAdvertising", isAdvertising)
        result.putString("currentCapability", currentCapability)
        promise.resolve(result)
    }

    // Required stubs for React Native EventEmitter compatibility
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
