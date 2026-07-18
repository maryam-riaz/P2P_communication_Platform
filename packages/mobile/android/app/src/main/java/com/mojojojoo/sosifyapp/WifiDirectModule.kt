package com.mojojojoo.sosifyapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WpsInfo
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pDeviceList
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.WifiP2pManager.ActionListener
import android.net.wifi.p2p.WifiP2pManager.Channel
import android.net.wifi.p2p.WifiP2pManager.PeerListListener
import android.net.wifi.p2p.WifiP2pManager.ConnectionInfoListener
import android.net.wifi.WifiManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

/**
 * Native Android Wi-Fi Direct module for React Native.
 *
 * Exposes WifiP2pManager peer discovery, connection, and group owner
 * IP resolution to the JavaScript layer via NativeModules.WifiDirect.
 *
 * Also provides native TCP socket server/client methods so the JS
 * layer does not need to import Node's "net" module (unavailable in RN).
 *
 * Events emitted to JS:
 *   - "WifiDirectPeersChanged"    — array of {deviceName, deviceAddress, status}
 *   - "WifiDirectConnectionInfo"  — {groupOwnerAddress, isGroupOwner}
 *   - "WifiDirectStateChanged"    — {enabled: boolean}
 *   - "WifiDirectTcpData"         — base64-encoded incoming data string
 *   - "WifiDirectTcpConnected"    — fired when a client connects to the server
 *   - "WifiDirectTcpDisconnected" — fired when the TCP connection closes
 */
class WifiDirectModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val wifiP2pManager: WifiP2pManager =
        reactContext.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager
    private val wifiManager: WifiManager =
        reactContext.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val connectivityManager: ConnectivityManager =
        reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private lateinit var channel: Channel
    private var broadcastReceiver: WifiDirectBroadcastReceiver? = null

    // Wi-Fi Direct P2P network — captured after group formation and used to
    // bind TCP client sockets to the correct (non-internet) network interface.
    // Without this binding, Socket.connect() may route through the mobile
    // data interface, causing TCP timeouts.
    private var p2pNetwork: Network? = null
    private var p2pNetworkCallback: ConnectivityManager.NetworkCallback? = null

    // TCP socket state
    private val executor = Executors.newCachedThreadPool()
    private var serverSocket: ServerSocket? = null
    private var clientSocket: Socket? = null
    private var outputStream: OutputStream? = null

    override fun getName(): String = "WifiDirect"

    @ReactMethod
    fun isWifiEnabled(promise: Promise) {
        try {
            promise.resolve(wifiManager.isWifiEnabled)
        } catch (e: Exception) {
            promise.reject("WIFI_STATE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setWifiEnabled(enabled: Boolean, promise: Promise) {
        try {
            wifiManager.isWifiEnabled = enabled
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WIFI_TOGGLE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setBluetoothEnabled(enabled: Boolean, promise: Promise) {
        try {
            val bluetoothManager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val bluetoothAdapter = bluetoothManager?.adapter ?: BluetoothAdapter.getDefaultAdapter()
            if (bluetoothAdapter == null) {
                promise.reject("NO_BLUETOOTH", "Device does not support Bluetooth")
                return
            }
            val success = if (enabled) {
                bluetoothAdapter.enable()
            } else {
                bluetoothAdapter.disable()
            }
            promise.resolve(success)
        } catch (e: Exception) {
            promise.reject("BLUETOOTH_TOGGLE_ERROR", e.message, e)
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    @ReactMethod
    fun initialize(promise: Promise) {
        try {
            channel = wifiP2pManager.initialize(reactContext, reactContext.mainLooper, null)

            val intentFilter = IntentFilter().apply {
                addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
                addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
                addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
                addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION)
            }

            broadcastReceiver = WifiDirectBroadcastReceiver(wifiP2pManager, channel, this)
            reactContext.registerReceiver(broadcastReceiver, intentFilter)

            // Register network callback to capture the Wi-Fi Direct P2P network
            // after group formation. This is critical for Android 5+ where TCP
            // client sockets must be bound to the P2P network to avoid routing
            // through the mobile data interface.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                val networkRequest = NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .build()
                p2pNetworkCallback = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        // Check if this network has a P2P-like link property
                        val caps = connectivityManager.getNetworkCapabilities(network)
                        val lp = connectivityManager.getLinkProperties(network)
                        val isP2p = lp?.interfaceName?.startsWith("p2p") == true ||
                            lp?.linkAddresses?.any { addr ->
                                val host = addr.address?.hostAddress ?: ""
                                host.startsWith("192.168.49.") || host.startsWith("192.168.50.")
                            } == true
                        if (isP2p) {
                            p2pNetwork = network
                            android.util.Log.d("WifiDirectModule", "P2P network captured: ${lp?.interfaceName} -> $network")
                        }
                    }
                    override fun onLost(network: Network) {
                        if (network == p2pNetwork) {
                            p2pNetwork = null
                            android.util.Log.d("WifiDirectModule", "P2P network lost: $network")
                        }
                    }
                }
                connectivityManager.registerNetworkCallback(networkRequest, p2pNetworkCallback!!)
            }

            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("WIFI_DIRECT_INIT_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun cleanup(promise: Promise) {
        try {
            broadcastReceiver?.let { reactContext.unregisterReceiver(it) }
            broadcastReceiver = null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                p2pNetworkCallback?.let { connectivityManager.unregisterNetworkCallback(it) }
                p2pNetworkCallback = null
            }
            p2pNetwork = null
            closeTcpResources()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("WIFI_DIRECT_CLEANUP_ERROR", e.message, e)
        }
    }

    // ─── Peer Discovery ───────────────────────────────────────────────────────

    /**
     * Initiates Wi-Fi Direct peer discovery.
     * Results are delivered via the "WifiDirectPeersChanged" event.
     */
    @ReactMethod
    fun discoverPeers(promise: Promise) {
        wifiP2pManager.discoverPeers(channel, object : ActionListener {
            override fun onSuccess() {
                promise.resolve(null)
            }
            override fun onFailure(reason: Int) {
                promise.reject("DISCOVER_PEERS_FAILED", "Reason code: $reason")
            }
        })
    }

    /**
     * Requests the current peer list from WifiP2pManager.
     * Results are delivered via the "WifiDirectPeersChanged" event.
     */
    @ReactMethod
    fun requestPeers(promise: Promise) {
        wifiP2pManager.requestPeers(channel) { deviceList: WifiP2pDeviceList ->
            val peersArray = Arguments.createArray()
            for (device in deviceList.deviceList) {
                val map = Arguments.createMap()
                map.putString("deviceName", device.deviceName)
                map.putString("deviceAddress", device.deviceAddress)
                map.putInt("status", device.status)
                peersArray.pushMap(map)
            }
            sendEvent("WifiDirectPeersChanged", peersArray)
            promise.resolve(peersArray)
        }
    }

    // ─── Connection ───────────────────────────────────────────────────────────

    /**
     * Connects to a peer by MAC address and forms a Wi-Fi Direct group.
     * After connection, call getConnectionInfo() to retrieve the group owner IP.
     */
    @ReactMethod
    fun connectToPeer(deviceAddress: String, promise: Promise) {
        val config = WifiP2pConfig().apply {
            this.deviceAddress = deviceAddress
            this.wps.setup = WpsInfo.PBC
        }
        wifiP2pManager.connect(channel, config, object : ActionListener {
            override fun onSuccess() {
                promise.resolve(null)
            }
            override fun onFailure(reason: Int) {
                promise.reject("CONNECT_FAILED", "Reason code: $reason")
            }
        })
    }

    /**
     * Requests the current Wi-Fi Direct connection info (group owner IP, isGroupOwner).
     * Results are delivered via the "WifiDirectConnectionInfo" event AND resolved in the promise.
     */
    @ReactMethod
    fun getConnectionInfo(promise: Promise) {
        wifiP2pManager.requestConnectionInfo(channel) { info: WifiP2pInfo ->
            val mapForEvent = Arguments.createMap()
            mapForEvent.putString("groupOwnerAddress", info.groupOwnerAddress?.hostAddress ?: "")
            mapForEvent.putBoolean("isGroupOwner", info.isGroupOwner)
            mapForEvent.putBoolean("groupFormed", info.groupFormed)
            
            val mapForPromise = Arguments.createMap()
            mapForPromise.putString("groupOwnerAddress", info.groupOwnerAddress?.hostAddress ?: "")
            mapForPromise.putBoolean("isGroupOwner", info.isGroupOwner)
            mapForPromise.putBoolean("groupFormed", info.groupFormed)
            
            sendEvent("WifiDirectConnectionInfo", mapForEvent)
            promise.resolve(mapForPromise)
        }
    }

    /**
     * Removes the current Wi-Fi Direct group (disconnects all peers).
     */
    @ReactMethod
    fun disconnect(promise: Promise) {
        wifiP2pManager.removeGroup(channel, object : ActionListener {
            override fun onSuccess() {
                promise.resolve(null)
            }
            override fun onFailure(reason: Int) {
                promise.reject("DISCONNECT_FAILED", "Reason code: $reason")
            }
        })
    }

    @ReactMethod
    fun deletePersistentGroups(promise: Promise) {
        executor.execute {
            try {
                val methods = WifiP2pManager::class.java.methods
                var requestPersistentGroupInfoMethod: java.lang.reflect.Method? = null
                var deletePersistentGroupMethod: java.lang.reflect.Method? = null
                
                for (method in methods) {
                    if (method.name == "requestPersistentGroupInfo") {
                        requestPersistentGroupInfoMethod = method
                    } else if (method.name == "deletePersistentGroup") {
                        deletePersistentGroupMethod = method
                    }
                }
                
                if (requestPersistentGroupInfoMethod != null && deletePersistentGroupMethod != null) {
                    val persistentGroupInfoListenerClass = Class.forName("android.net.wifi.p2p.WifiP2pManager\$PersistentGroupInfoListener")
                    
                    val listenerProxy = java.lang.reflect.Proxy.newProxyInstance(
                        WifiP2pManager::class.java.classLoader,
                        arrayOf(persistentGroupInfoListenerClass),
                        java.lang.reflect.InvocationHandler { _, method, args ->
                            if (method.name == "onPersistentGroupInfoAvailable") {
                                val groupListObj = args?.get(0)
                                if (groupListObj != null) {
                                    val getGroupListMethod = groupListObj.javaClass.getMethod("getGroupList")
                                    val groupList = getGroupListMethod.invoke(groupListObj) as Collection<*>
                                    for (group in groupList) {
                                        if (group != null) {
                                            val getNetworkIdMethod = group.javaClass.getMethod("getNetworkId")
                                            val networkId = getNetworkIdMethod.invoke(group) as Int
                                            
                                            deletePersistentGroupMethod.invoke(
                                                wifiP2pManager,
                                                channel,
                                                networkId,
                                                object : WifiP2pManager.ActionListener {
                                                    override fun onSuccess() {
                                                        android.util.Log.d("WifiDirectModule", "Deleted persistent group: $networkId")
                                                    }
                                                    override fun onFailure(reason: Int) {
                                                        android.util.Log.e("WifiDirectModule", "Failed to delete persistent group $networkId: $reason")
                                                    }
                                                }
                                            )
                                        }
                                    }
                                }
                            }
                            null
                        }
                    )
                    
                    requestPersistentGroupInfoMethod.invoke(wifiP2pManager, channel, listenerProxy)
                    promise.resolve(true)
                } else {
                    android.util.Log.w("WifiDirectModule", "Persistent P2P APIs not found on this device class.")
                    promise.resolve(false)
                }
            } catch (e: Exception) {
                android.util.Log.e("WifiDirectModule", "Reflection error in deletePersistentGroups", e)
                promise.reject("REFLECTION_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun cancelConnect(promise: Promise) {
        wifiP2pManager.cancelConnect(channel, object : ActionListener {
            override fun onSuccess() {
                promise.resolve(null)
            }
            override fun onFailure(reason: Int) {
                promise.resolve(null)
            }
        })
    }

    // ─── TCP Socket Layer ─────────────────────────────────────────────────────

    /**
     * Opens a TCP ServerSocket on the given port (default 8888).
     * The socket is bound to the P2P interface's local IP when available,
     * ensuring it only accepts connections from the Wi-Fi Direct P2P subnet.
     *
     * Fires "WifiDirectTcpConnected" when a client connects.
     * Fires "WifiDirectTcpData" (base64 string) for every incoming data chunk.
     * Fires "WifiDirectTcpDisconnected" when the connection closes.
     */
    @ReactMethod
    fun openServerSocket(port: Int, promise: Promise) {
        executor.execute {
            try {
                // Bind ServerSocket to the P2P interface's local IP if available
                val p2pAddress = findP2pLocalAddress()
                if (p2pAddress != null) {
                    serverSocket = ServerSocket(port, 50, p2pAddress)
                    android.util.Log.d("WifiDirectModule", "ServerSocket bound to P2P address: ${p2pAddress.hostAddress}:$port")
                } else {
                    serverSocket = ServerSocket(port)
                    android.util.Log.d("WifiDirectModule", "ServerSocket bound to 0.0.0.0:$port (no P2P address found)")
                }
                promise.resolve(null)

                // Accept a single client (Wi-Fi Direct is point-to-point)
                val sock = serverSocket!!.accept()
                clientSocket = sock
                outputStream = sock.getOutputStream()
                sendEvent("WifiDirectTcpConnected", null)

                readLoop(sock.getInputStream())
            } catch (e: Exception) {
                if (serverSocket?.isClosed == false) {
                    promise.reject("TCP_SERVER_ERROR", e.message, e)
                }
                sendEvent("WifiDirectTcpDisconnected", null)
            }
        }
    }

    /**
     * Connects as a TCP client to the given IP:port.
     * Fires "WifiDirectTcpData" (base64 string) for every incoming data chunk.
     * Fires "WifiDirectTcpDisconnected" when the connection closes.
     *
     * CRITICAL: The socket is explicitly bound to the Wi-Fi Direct P2P network
     * (if available) to prevent Android's routing layer from sending TCP
     * packets through the mobile data interface — the root cause of
     * socket timeout errors during peer-to-peer connections.
     */
    @ReactMethod
    fun connectToSocket(ipAddress: String, port: Int, promise: Promise) {
        executor.execute {
            try {
                val sock = Socket()
                // Bind the socket to the Wi-Fi Direct P2P network so TCP
                // segments go through the P2P interface, not mobile data.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    val network = p2pNetwork
                    if (network != null) {
                        network.bindSocket(sock)
                        android.util.Log.d("WifiDirectModule", "Socket bound to P2P network: $network")
                    } else {
                        android.util.Log.w("WifiDirectModule", "No P2P network captured — socket may route through default network")
                    }
                }
                // Use a 15-second connect timeout to prevent indefinite
                // blocking when the peer is unreachable.
                sock.connect(InetSocketAddress(ipAddress, port), 15000)
                clientSocket = sock
                outputStream = sock.getOutputStream()
                promise.resolve(null)

                readLoop(sock.getInputStream())
            } catch (e: Exception) {
                promise.reject("TCP_CONNECT_ERROR", e.message, e)
                sendEvent("WifiDirectTcpDisconnected", null)
            }
        }
    }

    /**
     * Sends a base64-encoded byte array over the open TCP socket.
     */
    @ReactMethod
    fun tcpSend(base64Data: String, promise: Promise) {
        val out = outputStream
        if (out == null) {
            promise.reject("TCP_NOT_CONNECTED", "No active TCP connection.")
            return
        }
        executor.execute {
            try {
                val bytes = android.util.Base64.decode(base64Data, android.util.Base64.NO_WRAP)
                out.write(bytes)
                out.flush()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("TCP_SEND_ERROR", e.message, e)
            }
        }
    }

    /**
     * Closes the TCP socket and server socket.
     */
    @ReactMethod
    fun tcpDisconnect(promise: Promise) {
        try {
            closeTcpResources()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("TCP_DISCONNECT_ERROR", e.message, e)
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Finds the local IP address assigned to the Wi-Fi Direct P2P interface.
     * This is used to bind the ServerSocket to the correct interface so that
     * TCP connections from the P2P client reach the server reliably.
     *
     * Returns null if no P2P interface is active.
     */
    private fun findP2pLocalAddress(): InetAddress? {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces?.hasMoreElements() == true) {
                val iface = interfaces.nextElement()
                if (iface.name.startsWith("p2p") || iface.name.startsWith("eth0")) {
                    val addresses = iface.inetAddresses
                    while (addresses?.hasMoreElements() == true) {
                        val addr = addresses.nextElement()
                        if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) {
                            android.util.Log.d("WifiDirectModule", "Found P2P local address: ${addr.hostAddress} on ${iface.name}")
                            return addr
                        }
                    }
                }
            }
        } catch (e: Exception) {
            android.util.Log.e("WifiDirectModule", "Error finding P2P local address", e)
        }
        // Fallback: also check ConnectivityManager's link properties for the
        // P2P network if we captured it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val network = p2pNetwork ?: return null
            val lp = connectivityManager.getLinkProperties(network) ?: return null
            for (linkAddr in lp.linkAddresses) {
                val candidate = linkAddr.address ?: continue
                if (!candidate.isLoopbackAddress && candidate is java.net.Inet4Address) {
                    android.util.Log.d("WifiDirectModule", "Found P2P local address via link props: ${candidate.hostAddress}")
                    return candidate
                }
            }
        }
        return null
    }

    private fun readLoop(input: InputStream) {
        val buffer = ByteArray(262144) // 256KB read buffer — reduces React Native bridge events by 64x
        try {
            var bytesRead: Int
            while (input.read(buffer).also { bytesRead = it } != -1) {
                val chunk = buffer.copyOf(bytesRead)
                val b64 = android.util.Base64.encodeToString(chunk, android.util.Base64.NO_WRAP)
                sendEvent("WifiDirectTcpData", b64)
            }
        } catch (_: Exception) {
            // Socket closed
        } finally {
            sendEvent("WifiDirectTcpDisconnected", null)
            closeTcpResources()
        }
    }


    private fun closeTcpResources() {
        try { outputStream?.close() } catch (_: Exception) {}
        try { clientSocket?.close() } catch (_: Exception) {}
        try { serverSocket?.close() } catch (_: Exception) {}
        outputStream = null
        clientSocket = null
        serverSocket = null
    }

    // ─── Event Emitter ────────────────────────────────────────────────────────

    internal fun sendEvent(eventName: String, params: Any?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun writeBase64ToFile(base64Str: String, fileName: String, promise: Promise) {
        try {
            var cleanBase64 = base64Str
            if (base64Str.contains(",")) {
                cleanBase64 = base64Str.substring(base64Str.indexOf(",") + 1)
            }
            val decodedBytes = android.util.Base64.decode(cleanBase64, android.util.Base64.DEFAULT)
            val cacheDir = reactContext.cacheDir
            val file = java.io.File(cacheDir, fileName)
            java.io.FileOutputStream(file).use { fos ->
                fos.write(decodedBytes)
            }
            promise.resolve("file://" + file.absolutePath)
        } catch (e: Exception) {
            promise.reject("WRITE_FILE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun readFileAsBase64(fileUri: String, promise: Promise) {
        try {
            var path = fileUri
            if (path.startsWith("file://")) {
                path = path.substring(7)
            }
            val file = java.io.File(path)
            val bytes = file.readBytes()
            val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            promise.resolve(b64)
        } catch (e: Exception) {
            promise.reject("READ_FILE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getFileSize(fileUri: String, promise: Promise) {
        try {
            var path = fileUri
            if (path.startsWith("file://")) {
                path = path.substring(7)
            }
            val file = java.io.File(path)
            if (file.exists()) {
                promise.resolve(file.length().toDouble())
            } else {
                promise.reject("READ_FILE_ERROR", "File does not exist: $path")
            }
        } catch (e: Exception) {
            promise.reject("READ_FILE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun readChunkAsBase64(fileUri: String, offset: Double, length: Int, promise: Promise) {
        try {
            var path = fileUri
            if (path.startsWith("file://")) {
                path = path.substring(7)
            }
            val file = java.io.File(path)
            if (!file.exists()) {
                promise.reject("READ_FILE_ERROR", "File does not exist: $path")
                return
            }
            val randomAccessFile = java.io.RandomAccessFile(file, "r")
            randomAccessFile.seek(offset.toLong())
            val buffer = ByteArray(length)
            val bytesRead = randomAccessFile.read(buffer)
            randomAccessFile.close()
            
            val readBytes = if (bytesRead == length) {
                buffer
            } else if (bytesRead > 0) {
                buffer.copyOf(bytesRead)
            } else {
                ByteArray(0)
            }
            
            val b64 = android.util.Base64.encodeToString(readBytes, android.util.Base64.NO_WRAP)
            promise.resolve(b64)
        } catch (e: Exception) {
            promise.reject("READ_FILE_ERROR", e.message, e)
        }
    }


    // Required for addListener / removeListeners called by React Native EventEmitter
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}

// ─── Broadcast Receiver ───────────────────────────────────────────────────────

/**
 * Receives system Wi-Fi Direct broadcasts and forwards them to the JS module.
 */
class WifiDirectBroadcastReceiver(
    private val manager: WifiP2pManager,
    private val channel: Channel,
    private val module: WifiDirectModule
) : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                val state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1)
                val enabled = state == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                val map = Arguments.createMap()
                map.putBoolean("enabled", enabled)
                module.sendEvent("WifiDirectStateChanged", map)
            }
            WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> {
                // Request the updated peer list
                manager.requestPeers(channel) { deviceList: WifiP2pDeviceList ->
                    val peersArray = Arguments.createArray()
                    for (device in deviceList.deviceList) {
                        val map = Arguments.createMap()
                        map.putString("deviceName", device.deviceName)
                        map.putString("deviceAddress", device.deviceAddress)
                        map.putInt("status", device.status)
                        peersArray.pushMap(map)
                    }
                    module.sendEvent("WifiDirectPeersChanged", peersArray)
                }
            }
            WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
                // Connection state changed — request connection info
                manager.requestConnectionInfo(channel) { info: WifiP2pInfo ->
                    val map = Arguments.createMap()
                    map.putString("groupOwnerAddress", info.groupOwnerAddress?.hostAddress ?: "")
                    map.putBoolean("isGroupOwner", info.isGroupOwner)
                    map.putBoolean("groupFormed", info.groupFormed)
                    module.sendEvent("WifiDirectConnectionInfo", map)
                }
            }
            WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION -> {
                val device = intent.getParcelableExtra(WifiP2pManager.EXTRA_WIFI_P2P_DEVICE) as? WifiP2pDevice
                if (device != null) {
                    val map = Arguments.createMap()
                    map.putString("deviceName", device.deviceName)
                    map.putString("deviceAddress", device.deviceAddress)
                    map.putInt("status", device.status)
                    module.sendEvent("WifiDirectThisDeviceChanged", map)
                }
            }
        }
    }
}
