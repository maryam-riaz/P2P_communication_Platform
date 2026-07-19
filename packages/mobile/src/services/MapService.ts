import { Database } from '@nozbe/watermelondb';
import * as Location from 'expo-location';
import { InteractionManager } from 'react-native';
import { MobileRepository } from '../db/repository';
import { KnownPeer, LocationLog } from '../db/models';
import { Observable, Subject, map, combineLatest, startWith, throttleTime } from 'rxjs';
import { ChatService } from './ChatService';

export interface PeerPin {
  deviceId: string;
  role: string;
  lat: number | null;
  lng: number | null;
  displayName: string;
  rssi: number;
}

export class MapService {
  private repository: MobileRepository;
  private locationSubscription: Location.LocationSubscription | null = null;
  private myLocationSubject = new Subject<{ latitude: number; longitude: number; accuracy: number }>();
  private chatService: ChatService | null = null;

  // Ephemeral RSSI storage to avoid write-heavy database churn
  private peerRssiMap = new Map<string, number>();
  private peerLastSeenMap = new Map<string, number>();
  private rssiUpdateSubject = new Subject<void>();
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastLocationBroadcastTime = 0;
  private static LOCATION_THROTTLE_MS = 5000;

  constructor(private db: Database) {
    this.repository = new MobileRepository(db);
    // Periodic cleanup of stale location_log entries (every 30 minutes)
    this.cleanupIntervalId = setInterval(() => {
      this.repository.cleanupOldLocations().catch((err) => {
        console.warn('[MapService] Location cleanup failed:', err);
      });
    }, 30 * 60 * 1000);
  }

  destroy(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.stopLocationTracking();
  }

  setChatService(chatService: ChatService) {
    this.chatService = chatService;
  }

  private lastRssiEmitMs = 0;

  updatePeerRssi(deviceId: string, rssi: number): void {
    this.peerRssiMap.set(deviceId, rssi);
    this.peerLastSeenMap.set(deviceId, Date.now());
    
    const now = Date.now();
    if (now - this.lastRssiEmitMs >= 500) {
      this.lastRssiEmitMs = now;
      this.rssiUpdateSubject.next();
    }
  }

  getPeerRssi(deviceId: string): number {
    return this.peerRssiMap.get(deviceId) ?? -100;
  }

  /**
   * Starts GPS location tracking, logging to database and dispatching updates.
   */
  async startLocationTracking(): Promise<void> {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Location permission denied');
      }

      // Try initial position fetch
      let coords: { latitude: number; longitude: number; accuracy: number } | null = null;
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        coords = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 0,
        };
      } catch (posErr) {
        console.warn('[MapService] getCurrentPositionAsync failed, trying last known position:', posErr);
        try {
          const lastPos = await Location.getLastKnownPositionAsync();
          if (lastPos) {
            coords = {
              latitude: lastPos.coords.latitude,
              longitude: lastPos.coords.longitude,
              accuracy: lastPos.coords.accuracy ?? 0,
            };
          }
        } catch (lastPosErr) {
          console.warn('[MapService] getLastKnownPositionAsync also failed:', lastPosErr);
        }
      }

      if (coords) {
        await this.handleLocationUpdate(coords);
      } else {
        console.warn('[MapService] Could not resolve initial location. Falling back to default region.');
      }

      // Watch position every 10 seconds (regardless of whether initial fetch succeeded or failed)
      this.locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 10000, // 10 seconds
          distanceInterval: 5,   // 5 meters
        },
        (loc) => {
          this.handleLocationUpdate({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? 0,
          });
        }
      );
    } catch (e: any) {
      console.warn('GPS location tracking error:', e);
      throw e;
    }
  }

  /**
   * Stops continuous location tracking.
   */
  stopLocationTracking(): void {
    if (this.locationSubscription) {
      this.locationSubscription.remove();
      this.locationSubscription = null;
    }
  }

  /**
   * Returns a live-updating stream of this device's own GPS coordinates.
   */
  observeMyLocation(): Observable<{ latitude: number; longitude: number; accuracy: number }> {
    return this.myLocationSubject.asObservable();
  }

  /**
   * Returns a live-updating stream of all discovered known peer locations mapped for the map pins.
   * Emits whenever the local peers DB table changes OR whenever BLE updates a peer's RSSI.
   */
  observePeerLocations(): Observable<PeerPin[]> {
    const peers$ = this.db.get<KnownPeer>('known_peers').query().observe();
    const rssiTrigger$ = this.rssiUpdateSubject.asObservable().pipe(
      throttleTime(3000),
      startWith(null)
    );

    return combineLatest([peers$, rssiTrigger$]).pipe(
      map(([peers]) => {
        const cutoff = Date.now() - 30000; // 30 seconds active cutoff
        
        // De-duplicate peers by device_id to solve key warnings and phantom peer counts
        const seen = new Set<string>();
        const uniquePeers: KnownPeer[] = [];
        for (const p of peers) {
          const devId = (p._raw as any).device_id;
          if (devId && !seen.has(devId)) {
            seen.add(devId);
            uniquePeers.push(p);
          }
        }

        return uniquePeers
          .filter((p) => {
            const rawPeer = p._raw as any;
            const lastSeen = this.peerLastSeenMap.get(rawPeer.device_id) ?? rawPeer.last_seen ?? 0;
            return lastSeen > cutoff;
          })
          .map((p) => {
            const rawPeer = p._raw as any;
            let lat: number | null = null;
            let lng: number | null = null;
            
            if (rawPeer.last_known_location && rawPeer.last_known_location !== '') {
            try {
              const parsed = JSON.parse(rawPeer.last_known_location);
              lat = parsed.lat;
              lng = parsed.lng;
            } catch (err) {
              console.warn('Failed to parse peer location JSON', err);
            }
          }

          const rssi = this.peerRssiMap.get(rawPeer.device_id) ?? -100;

          return {
            deviceId: rawPeer.device_id,
            role: rawPeer.role,
            lat,
            lng,
            displayName: rawPeer.display_name || rawPeer.device_id.slice(0, 8),
            rssi,
          };
        });
      })
    ) as any;
  }

  private async handleLocationUpdate(coords: { latitude: number; longitude: number; accuracy: number }) {
    // Always emit to the subject for immediate UI update (no DB write needed)
    this.myLocationSubject.next({
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: coords.accuracy,
    });

    const now = Date.now();
    if (now - this.lastLocationBroadcastTime < MapService.LOCATION_THROTTLE_MS) {
      return; // Throttled — skip DB write and peer broadcast
    }
    this.lastLocationBroadcastTime = now;

    const localUser = await this.repository.getLocalUser();
    if (localUser) {
      const myDeviceId = (localUser._raw as any).device_id as string;

      // 1. Log coordinates locally (offload to InteractionManager)
      InteractionManager.runAfterInteractions(() => {
        this.repository.logLocation({
          deviceId: myDeviceId,
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
          source: 'gps',
        }).catch(err => console.warn('[MapService] Failed to log location:', err));
      });

      // 2. Share coordinates with all active P2P sockets
      if (this.chatService) {
        const activeTransports = this.chatService.getAllActiveTransports();
        for (const [peerId, transport] of activeTransports.entries()) {
          if (transport.isHandshakeComplete()) {
            try {
              const payload = {
                type: 'location_share',
                senderId: myDeviceId,
                lat: coords.latitude,
                lng: coords.longitude,
                timestamp: Date.now(),
              };
              await transport.send(JSON.stringify(payload));
            } catch (err) {
              // Transport might be stale — skip silently
            }
          }
        }
      }
    }
  }
}
