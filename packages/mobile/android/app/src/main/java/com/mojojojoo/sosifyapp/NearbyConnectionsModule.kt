package com.mojojojoo.sosifyapp

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy

/**
 * Minimal React Native native module for Google Nearby Connections API.
 *
 * Exposes just enough to prove two Android devices can discover each other
 * and exchange "hello world" bytes with no internet, no UI.
 *
 * Accessed from JS as: NativeModules.NearbyConnections
 */
class NearbyConnectionsModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val nearbyClient = Nearby.getConnectionsClient(reactContext)
    private val connectedEndpoints = mutableSetOf<String>()

    override fun getName(): String = "NearbyConnections"

    // ─── Connection Lifecycle Callback ──────────────────────────────────────

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            val params = Arguments.createMap().apply {
                putString("endpointId", endpointId)
                putString("endpointName", info.endpointName)
                putString("authenticationToken", info.authenticationToken)
                putBoolean("isIncomingConnection", info.isIncomingConnection)
            }
            sendEvent("onConnectionInitiated", params)
            // Auto-accept for the spike
            nearbyClient.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            if (result.status.isSuccess) {
                connectedEndpoints.add(endpointId)
                sendEvent("onEndpointConnected", mapOf("endpointId" to endpointId))
            } else {
                sendEvent("onEndpointDisconnected", mapOf(
                    "endpointId" to endpointId,
                    "statusCode" to result.status.statusCode
                ))
            }
        }

        override fun onDisconnected(endpointId: String) {
            connectedEndpoints.remove(endpointId)
            sendEvent("onEndpointDisconnected", mapOf("endpointId" to endpointId))
        }
    }

    // ─── Payload Callback ────────────────────────────────────────────────────

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            val bytes = payload.asBytes() ?: return
            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            sendEvent("onPayloadReceived", mapOf(
                "endpointId" to endpointId,
                "data" to b64
            ))
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            // Not needed for the spike
        }
    }

    // ─── Endpoint Discovery Callback ─────────────────────────────────────────

    private val endpointDiscoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            sendEvent("onEndpointFound", mapOf(
                "endpointId" to endpointId,
                "endpointName" to info.endpointName,
                "serviceId" to info.serviceId
            ))
            // Auto-connect for the spike
            nearbyClient.requestConnection(
                reactContext.packageName,
                endpointId,
                connectionLifecycleCallback
            )
        }

        override fun onEndpointLost(endpointId: String) {
            sendEvent("onEndpointLost", mapOf("endpointId" to endpointId))
        }
    }

    // ─── React Native API ────────────────────────────────────────────────────

    @ReactMethod
    fun startAdvertising(serviceId: String, promise: Promise) {
        try {
            val options = AdvertisingOptions.Builder()
                .setStrategy(Strategy.P2P_STAR)
                .build()
            nearbyClient.startAdvertising(
                reactContext.packageName,
                serviceId,
                connectionLifecycleCallback,
                options
            ).addOnSuccessListener {
                promise.resolve(true)
            }.addOnFailureListener { e ->
                promise.reject("ADVERTISE_FAILED", e.message, e)
            }
        } catch (e: Exception) {
            promise.reject("ADVERTISE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun startDiscovery(serviceId: String, promise: Promise) {
        try {
            val options = DiscoveryOptions.Builder()
                .setStrategy(Strategy.P2P_STAR)
                .build()
            nearbyClient.startDiscovery(
                serviceId,
                endpointDiscoveryCallback,
                options
            ).addOnSuccessListener {
                promise.resolve(true)
            }.addOnFailureListener { e ->
                promise.reject("DISCOVERY_FAILED", e.message, e)
            }
        } catch (e: Exception) {
            promise.reject("DISCOVERY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun sendPayload(endpointId: String, base64Data: String, promise: Promise) {
        try {
            val bytes = Base64.decode(base64Data, Base64.NO_WRAP)
            val payload = Payload.fromBytes(bytes)
            nearbyClient.sendPayload(endpointId, payload)
                .addOnSuccessListener { promise.resolve(null) }
                .addOnFailureListener { e ->
                    promise.reject("SEND_FAILED", e.message, e)
                }
        } catch (e: Exception) {
            promise.reject("SEND_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun sendPayloadToAll(base64Data: String, promise: Promise) {
        try {
            val bytes = Base64.decode(base64Data, Base64.NO_WRAP)
            val payload = Payload.fromBytes(bytes)
            nearbyClient.sendPayload(connectedEndpoints.toList(), payload)
                .addOnSuccessListener { promise.resolve(null) }
                .addOnFailureListener { e ->
                    promise.reject("SEND_ALL_FAILED", e.message, e)
                }
        } catch (e: Exception) {
            promise.reject("SEND_ALL_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        try {
            nearbyClient.stopAdvertising()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STOP_ADVERTISE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        try {
            nearbyClient.stopDiscovery()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STOP_DISCOVERY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun disconnectFromEndpoint(endpointId: String, promise: Promise) {
        try {
            nearbyClient.disconnectFromEndpoint(endpointId)
            connectedEndpoints.remove(endpointId)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("DISCONNECT_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopAll(promise: Promise) {
        try {
            nearbyClient.stopAllEndpoints()
            connectedEndpoints.clear()
            nearbyClient.stopAdvertising()
            nearbyClient.stopDiscovery()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STOP_ALL_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getConnectedEndpoints(promise: Promise) {
        val array = Arguments.createArray()
        connectedEndpoints.forEach { array.pushString(it) }
        promise.resolve(array)
    }

    // ─── Event Emitter ───────────────────────────────────────────────────────

    private fun sendEvent(eventName: String, params: Map<String, Any?>) {
        val map = Arguments.createMap()
        params.forEach { (key, value) ->
            when (value) {
                is String -> map.putString(key, value)
                is Int -> map.putInt(key, value)
                is Boolean -> map.putBoolean(key, value)
                is Double -> map.putDouble(key, value)
            }
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, map)
    }

    private fun sendEvent(eventName: String, params: com.facebook.react.bridge.ReadableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
