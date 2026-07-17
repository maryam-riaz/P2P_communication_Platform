package com.mojojojoo.sosifyapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * React Native package that registers both native comms modules:
 *   - BleAdvertiserModule — BLE peripheral advertising (NativeModules.BleAdvertiser)
 *   - WifiDirectModule    — Wi-Fi Direct P2P networking (NativeModules.WifiDirect)
 */
class CommsPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(
            BleAdvertiserModule(reactContext),
            WifiDirectModule(reactContext)
        )

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
