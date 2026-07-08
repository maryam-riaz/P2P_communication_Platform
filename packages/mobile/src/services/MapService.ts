import { Database } from '@nozbe/watermelondb';
import * as Location from 'expo-location';
import { MobileRepository } from '../db/repository';
import { KnownPeer, LocationLog, LocalUser } from '../db/models';
import { Observable, Subject, map } from 'rxjs';


export interface PeerPin {
  deviceId: string;
  role: string;
  lat: number | null;
  lng: number | null;
  displayName: string;
}

export class MapService {
  private repository: MobileRepository;
  private locationSubscription: Location.LocationSubscription | null = null;
  private myLocationSubject = new Subject<{ latitude: number; longitude: number; accuracy: number }>();

  constructor(private db: Database) {
    this.repository = new MobileRepository(db);
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

      // Initial position fetch
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      await this.handleLocationUpdate(pos.coords);

      // Watch position every 10 seconds
      this.locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 10000, // 10 seconds
          distanceInterval: 5,   // 5 meters
        },
        (loc) => {
          this.handleLocationUpdate(loc.coords);
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
   */
  observePeerLocations(): Observable<PeerPin[]> {
    return this.db.get<KnownPeer>('known_peers').query().observe().pipe(
      map((peers) => {
        return peers.map((p) => {
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

          return {
            deviceId: rawPeer.device_id,
            role: rawPeer.role,
            lat,
            lng,
            displayName: rawPeer.display_name || rawPeer.device_id.slice(0, 8),
          };
        });
      })
    ) as any;
  }

  private async handleLocationUpdate(coords: { latitude: number; longitude: number; accuracy: number }) {
    this.myLocationSubject.next({
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: coords.accuracy,
    });

    const localUser = await this.repository.getLocalUser();
    if (localUser) {
      const myDeviceId = localUser._raw.device_id as string;
      await this.repository.logLocation({
        deviceId: myDeviceId,
        lat: coords.latitude,
        lng: coords.longitude,
        accuracy: coords.accuracy,
        source: 'gps',
      });
    }
  }
}
