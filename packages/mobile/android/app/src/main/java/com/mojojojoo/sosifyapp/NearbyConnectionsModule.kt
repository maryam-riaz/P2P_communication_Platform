package com.mojojojoo.sosifyapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.app.NotificationCompat
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
import kotlin.math.min
import kotlin.math.pow

class NearbyConnectionsModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val nearbyClient = Nearby.getConnectionsClient(reactContext)
    private val connectedEndpoints = mutableSetOf<String>()
    private val discoveredEndpoints = mutableMapOf<String, DiscoveredEndpointInfo>()
    private val pendingConnections = mutableSetOf<String>()
    private val reconnectRunnables = mutableMapOf<String, Runnable>()
    private val reconnectAttempts = mutableMapOf<String, Int>()
    private val reconnectHandler = Handler(Looper.getMainLooper())
    private var isAdvertising = false
    private var isDiscovering = false
    private var currentServiceId = SERVICE_ID_DEFAULT
    private var currentDeviceName = ""

    override fun getName(): String = "NearbyConnections"

    override fun getConstants(): Map<String, Any> = mapOf(
        "SERVICE_ID_DEFAULT" to SERVICE_ID_DEFAULT,
        "RECONNECT_MAX_ATTEMPTS" to MAX_RECONNECT,
    )

    companion object {
        const val SERVICE_ID_DEFAULT = "com.mojojojoo.sosifyapp.p2p"
        const val MAX_RECONNECT = 5
        const val BASE_DELAY_MS = 1000L
        const val MAX_DELAY_MS = 60_000L

        const val NOTIFICATION_CHANNEL_ID = "sosify-mesh"
        const val NOTIFICATION_ID = 1
        const val FOREGROUND_SERVICE_NOTIFICATION_ID = 2

        private var foregroundServiceActive = false

        fun isForegroundServiceActive(): Boolean = foregroundServiceActive

        fun startForegroundService(context: Context) {
            if (foregroundServiceActive) return
            foregroundServiceActive = true
            val intent = Intent(context, MeshForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopForegroundService(context: Context) {
            if (!foregroundServiceActive) return
            foregroundServiceActive = false
            val intent = Intent(context, MeshForegroundService::class.java)
            context.stopService(intent)
        }
    }

    // ─── Connection Lifecycle Callback ──────────────────────────────────────

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            sendEvent("onConnectionInitiated", mapOf(
                "endpointId" to endpointId,
                "endpointName" to info.endpointName,
                "authenticationToken" to info.authenticationToken,
                "isIncomingConnection" to info.isIncomingConnection,
            ))
            nearbyClient.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            pendingConnections.remove(endpointId)
            if (result.status.isSuccess) {
                connectedEndpoints.add(endpointId)
                cancelReconnect(endpointId)
                sendEvent("onEndpointConnected", mapOf("endpointId" to endpointId))
                updateForegroundNotification()
            } else {
                sendEvent("onEndpointDisconnected", mapOf(
                    "endpointId" to endpointId,
                    "unexpected" to false,
                    "statusCode" to result.status.statusCode,
                ))
            }
        }

        override fun onDisconnected(endpointId: String) {
            connectedEndpoints.remove(endpointId)
            sendEvent("onEndpointDisconnected", mapOf(
                "endpointId" to endpointId,
                "unexpected" to true,
            ))
            updateForegroundNotification()
            if (discoveredEndpoints.containsKey(endpointId)) {
                scheduleReconnect(endpointId)
            }
        }
    }

    // ─── Payload Callback ────────────────────────────────────────────────────

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            val bytes = payload.asBytes() ?: return
            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            sendEvent("onPayloadReceived", mapOf(
                "endpointId" to endpointId,
                "data" to b64,
            ))
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            sendEvent("onPayloadProgress", mapOf(
                "endpointId" to endpointId,
                "payloadId" to update.payloadId.toString(),
                "bytesTransferred" to update.bytesTransferred.toDouble(),
                "totalBytes" to update.totalBytes.toDouble(),
                "status" to when (update.status) {
                    PayloadTransferUpdate.Status.IN_PROGRESS -> "in_progress"
                    PayloadTransferUpdate.Status.SUCCESS -> "success"
                    PayloadTransferUpdate.Status.FAILURE -> "failure"
                    else -> "in_progress"
                },
            ))
        }
    }

    // ─── Endpoint Discovery Callback ─────────────────────────────────────────

    private val endpointDiscoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            discoveredEndpoints[endpointId] = info
            sendEvent("onEndpointFound", mapOf(
                "endpointId" to endpointId,
                "endpointName" to info.endpointName,
                "serviceId" to info.serviceId,
            ))
        }

        override fun onEndpointLost(endpointId: String) {
            discoveredEndpoints.remove(endpointId)
            sendEvent("onEndpointLost", mapOf("endpointId" to endpointId))
        }
    }

    // ─── Reconnection Logic ──────────────────────────────────────────────────

    private fun scheduleReconnect(endpointId: String) {
        val attempts = reconnectAttempts.getOrDefault(endpointId, 0) + 1
        if (attempts > MAX_RECONNECT) {
            reconnectAttempts.remove(endpointId)
            reconnectRunnables.remove(endpointId)
            discoveredEndpoints.remove(endpointId)
            sendEvent("onReconnectionFailed", mapOf("endpointId" to endpointId))
            return
        }
        reconnectAttempts[endpointId] = attempts

        val delay = min(BASE_DELAY_MS * (2.0.pow((attempts - 1).toDouble())).toLong(), MAX_DELAY_MS)
        sendEvent("onReconnecting", mapOf(
            "endpointId" to endpointId,
            "attempt" to attempts,
            "maxAttempts" to MAX_RECONNECT,
        ))

        val runnable = Runnable {
            val info = discoveredEndpoints[endpointId]
            if (info == null) {
                reconnectAttempts.remove(endpointId)
                reconnectRunnables.remove(endpointId)
                return@Runnable
            }
            nearbyClient.requestConnection(
                currentDeviceName.ifEmpty { reactContext.packageName },
                endpointId,
                connectionLifecycleCallback,
            ).addOnFailureListener {
                scheduleReconnect(endpointId)
            }
        }
        reconnectRunnables[endpointId] = runnable
        reconnectHandler.postDelayed(runnable, delay)
    }

    private fun cancelReconnect(endpointId: String) {
        reconnectRunnables.remove(endpointId)?.let { runnable ->
            reconnectHandler.removeCallbacks(runnable)
        }
        reconnectAttempts.remove(endpointId)
    }

    private fun cancelAllReconnects() {
        reconnectRunnables.values.forEach { runnable ->
            reconnectHandler.removeCallbacks(runnable)
        }
        reconnectRunnables.clear()
        reconnectAttempts.clear()
    }

    // ─── Foreground Notification ─────────────────────────────────────────────

    private fun updateForegroundNotification() {
        val count = connectedEndpoints.size
        val notificationManager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Mesh Communication",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Ongoing notification for P2P mesh communication"
                setShowBadge(false)
            }
            notificationManager.createNotificationChannel(channel)
        }

        val notification = NotificationCompat.Builder(reactContext, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Mesh Active")
            .setContentText("$count peer${if (count != 1) "s" else ""} connected")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        val notificationManagerCompat =
            reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManagerCompat.notify(FOREGROUND_SERVICE_NOTIFICATION_ID, notification)

        // Update the foreground service notification if running
        val serviceIntent = Intent(reactContext, MeshForegroundService::class.java)
        serviceIntent.putExtra("peerCount", count)
        serviceIntent.action = "UPDATE_NOTIFICATION"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(serviceIntent)
        }
    }

    // ─── React Native API ────────────────────────────────────────────────────

    @ReactMethod
    fun startAdvertising(serviceId: String, deviceName: String, promise: Promise) {
        if (isAdvertising) {
            promise.resolve(true)
            return
        }
        try {
            currentServiceId = serviceId.ifEmpty { SERVICE_ID_DEFAULT }
            currentDeviceName = deviceName
            val options = AdvertisingOptions.Builder()
                .setStrategy(Strategy.P2P_STAR)
                .build()
            nearbyClient.startAdvertising(
                deviceName.ifEmpty { reactContext.packageName },
                currentServiceId,
                connectionLifecycleCallback,
                options,
            ).addOnSuccessListener {
                isAdvertising = true
                startForegroundService(reactContext)
                promise.resolve(true)
            }.addOnFailureListener { e ->
                promise.reject("ERR_ADVERTISE_FAILED", e.message, e)
            }
        } catch (e: Exception) {
            promise.reject("ERR_ADVERTISE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        try {
            nearbyClient.stopAdvertising()
            isAdvertising = false
            checkStopForegroundService()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("ERR_STOP_ADVERTISE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun startDiscovery(serviceId: String, promise: Promise) {
        if (isDiscovering) {
            promise.resolve(true)
            return
        }
        try {
            currentServiceId = serviceId.ifEmpty { SERVICE_ID_DEFAULT }
            val options = DiscoveryOptions.Builder()
                .setStrategy(Strategy.P2P_STAR)
                .build()
            nearbyClient.startDiscovery(
                currentServiceId,
                endpointDiscoveryCallback,
                options,
            ).addOnSuccessListener {
                isDiscovering = true
                startForegroundService(reactContext)
                promise.resolve(true)
            }.addOnFailureListener { e ->
                promise.reject("ERR_DISCOVERY_FAILED", e.message, e)
            }
        } catch (e: Exception) {
            promise.reject("ERR_DISCOVERY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        try {
            nearbyClient.stopDiscovery()
            isDiscovering = false
            discoveredEndpoints.clear()
            checkStopForegroundService()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("ERR_STOP_DISCOVERY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun connect(endpointId: String, promise: Promise) {
        if (connectedEndpoints.contains(endpointId)) {
            promise.resolve(true)
            return
        }
        if (pendingConnections.contains(endpointId)) {
            promise.resolve(true)
            return
        }
        if (!discoveredEndpoints.containsKey(endpointId)) {
            promise.reject("ERR_ENDPOINT_NOT_FOUND", "Endpoint $endpointId not discovered")
            return
        }
        pendingConnections.add(endpointId)
        cancelReconnect(endpointId)
        nearbyClient.requestConnection(
            currentDeviceName.ifEmpty { reactContext.packageName },
            endpointId,
            connectionLifecycleCallback,
        ).addOnSuccessListener {
            promise.resolve(true)
        }.addOnFailureListener { e ->
            pendingConnections.remove(endpointId)
            promise.reject("ERR_CONNECT_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun disconnectFromEndpoint(endpointId: String, promise: Promise) {
        try {
            cancelReconnect(endpointId)
            discoveredEndpoints.remove(endpointId)
            nearbyClient.disconnectFromEndpoint(endpointId)
            connectedEndpoints.remove(endpointId)
            updateForegroundNotification()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("ERR_DISCONNECT_ERROR", e.message, e)
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
                    promise.reject("ERR_SEND_FAILED", e.message, e)
                }
        } catch (e: Exception) {
            promise.reject("ERR_SEND_ERROR", e.message, e)
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
                    promise.reject("ERR_SEND_ALL_FAILED", e.message, e)
                }
        } catch (e: Exception) {
            promise.reject("ERR_SEND_ALL_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getConnectedEndpoints(promise: Promise) {
        val array = Arguments.createArray()
        connectedEndpoints.forEach { array.pushString(it) }
        promise.resolve(array)
    }

    @ReactMethod
    fun getRSSI(endpointId: String, promise: Promise) {
        promise.reject("ERR_RSSI_NOT_AVAILABLE", "RSSI not available via Nearby Connections API")
    }

    @ReactMethod
    fun stopAll(promise: Promise) {
        try {
            nearbyClient.stopAllEndpoints()
            connectedEndpoints.clear()
            pendingConnections.clear()
            cancelAllReconnects()
            isAdvertising = false
            isDiscovering = false
            discoveredEndpoints.clear()
            stopForegroundService(reactContext)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("ERR_STOP_ALL_ERROR", e.message, e)
        }
    }

    // ─── Foreground Service Control ──────────────────────────────────────────

    private fun checkStopForegroundService() {
        if (!isAdvertising && !isDiscovering) {
            stopForegroundService(reactContext)
        }
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
                is Long -> map.putDouble(key, value.toDouble())
            }
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, map)
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
