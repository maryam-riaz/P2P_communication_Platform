package com.mojojojoo.sosifyapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Foreground service required by Android 14+ (API 34+) for Wi-Fi Direct
 * connected device operations. The app keeps this service alive while
 * actively participating in a Wi-Fi Direct P2P group to ensure the OS
 * does not kill the networking process.
 *
 * Declared in AndroidManifest.xml with:
 *   android:foregroundServiceType="connectedDevice"
 */
class P2pForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "p2p_connected_device"
        const val NOTIFICATION_ID = 9001
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("P2P Connected")
            .setContentText("Maintaining peer-to-peer connection")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "P2P Connected Device",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Ongoing notification for Wi-Fi Direct P2P connection maintenance"
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }
}
