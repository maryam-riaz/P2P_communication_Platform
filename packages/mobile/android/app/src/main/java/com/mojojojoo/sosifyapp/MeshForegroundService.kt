package com.mojojojoo.sosifyapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class MeshForegroundService : Service() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val peerCount = intent?.getIntExtra("peerCount", 0) ?: 0
        val notification = buildNotification(peerCount)
        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Mesh Communication",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Ongoing notification for P2P mesh communication"
                setShowBadge(false)
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(peerCount: Int): Notification {
        val text = if (peerCount > 0) {
            "$peerCount peer${if (peerCount != 1) "s" else ""} connected"
        } else {
            "Listening for nearby devices..."
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Mesh Active")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "sosify-mesh"
        const val NOTIFICATION_ID = 1
    }
}
