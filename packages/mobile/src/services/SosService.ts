import { Database, Q } from '@nozbe/watermelondb';
import uuid from 'react-native-uuid';
import { sha256 } from 'js-sha256';
import { MobileRepository } from '../db/repository';
import { SosEvent, LocalUser, KnownPeer } from '../db/models';
import { ChatService } from './ChatService';
import { Observable, Subject } from 'rxjs';

export interface SosFormData {
  lat: number;
  lng: number;
  accuracy: number;
  location_source: string;
  severity: string;
  description: string;
}

export class SosService {
  private repository: MobileRepository;
  private incomingSosSubject = new Subject<SosEvent>();

  constructor(
    private db: Database,
    private chatService: ChatService
  ) {
    this.repository = new MobileRepository(db);
  }

  /**
   * Returns a live-updating stream of all open SOS incidents.
   */
  observeOpenSosEvents(): Observable<SosEvent[]> {
    return this.db.get<SosEvent>('sos_events')
      .query(Q.where('status', 'open'), Q.sortBy('created_at', Q.desc))
      .observe();
  }

  /**
   * Stream of incoming SOS alerts for triggering prominent UI banners.
   */
  onIncomingSosAlert(): Observable<SosEvent> {
    return this.incomingSosSubject.asObservable();
  }

  /**
   * Broadcasts a new SOS incident request to all known peers.
   */
  async broadcastSos(formData: SosFormData): Promise<string> {
    const localUser = await this.repository.getLocalUser();
    if (!localUser) throw new Error('No local profile found');

    const sosId = uuid.v4() as string;
    const timestamp = Date.now();
    const myDeviceId = (localUser._raw as any).device_id as string;

    // 1. Write locally
    await this.repository.createSosEvent({
      reporterId: myDeviceId,
      lat: formData.lat,
      lng: formData.lng,
      accuracy: formData.accuracy,
      locationSource: formData.location_source,
      severity: formData.severity,
      status: 'open',
    });

    // 2. Fetch all known peers from DB
    const peers = await this.db.get<KnownPeer>('known_peers').query().fetch();

    // 3. Format payload
    const sosPayload = {
      id: sosId,
      type: 'sos',
      reporterId: myDeviceId,
      severity: formData.severity,
      location: { lat: formData.lat, lng: formData.lng },
      description: formData.description || '',
      timestamp: new Date(timestamp).toISOString()
    };

    // 4. Send to all active peer connections
    for (const peer of peers) {
      const rawPeer = peer._raw as any;
      const secureTransport = this.chatService.getActiveTransport(rawPeer.device_id);
      
      if (secureTransport && secureTransport.isHandshakeComplete()) {
        try {
          await secureTransport.send(JSON.stringify(sosPayload));
        } catch (error) {
          console.warn(`Failed to broadcast SOS to peer ${rawPeer.device_id}`, error);
        }
      }
    }

    return sosId;
  }

  /**
   * Assigns the rescuer (local user) to coordinate a rescue for a specific SOS event.
   */
  async assignToSos(sosId: string): Promise<void> {
    const localUser = await this.repository.getLocalUser();
    if (!localUser) throw new Error('No local profile found');

    const myDeviceId = (localUser._raw as any).device_id as string;
    const myDisplayName = (localUser._raw as any).display_name as string;

    // Find the target incident
    const sosEvents = await this.db.get<SosEvent>('sos_events')
      .query(Q.where('id', Q.like(`%${sosId}%`))).fetch();
    if (sosEvents.length === 0) throw new Error('SOS incident not found in local DB');
    const incident = sosEvents[0];

    // 1. Update DB entry locally
    await this.db.write(async () => {
      await incident.update((record) => {
        (record._raw as any).assigned_rescuer_id = myDeviceId;
        (record._raw as any).status = 'assigned';
      });
    });

    // 2. Send notification to the reporter (victim)
    const secureTransport = this.chatService.getActiveTransport((incident._raw as any).reporter_id);
    if (secureTransport && secureTransport.isHandshakeComplete()) {
      try {
        const assignmentMessage = {
          id: uuid.v4(),
          type: 'sos_assignment',
          sosId,
          rescuerId: myDeviceId,
          rescuerName: myDisplayName,
          status: 'assigned',
          timestamp: new Date().toISOString()
        };
        await secureTransport.send(JSON.stringify(assignmentMessage));
      } catch (err) {
        console.warn(`Failed to send assignment notification back to victim`, err);
      }
    }
  }

  /**
   * Processes incoming SOS signals received over the mesh radio.
   */
  async handleIncomingSos(payload: any): Promise<void> {
    const { id, reporterId, severity, location, description, timestamp } = payload;
    const contentHash = sha256(JSON.stringify(payload));

    const existing = await this.db.get<SosEvent>('sos_events')
      .query(Q.where('reporter_id', reporterId), Q.where('created_at', new Date(timestamp).getTime())).fetch();
    
    if (existing.length > 0) return;

    // Save SOS incident locally
    const incident = await this.db.write(async () => {
      return await this.db.get<SosEvent>('sos_events').create((record) => {
        (record._raw as any).id = id;
        (record._raw as any).reporter_id = reporterId;
        (record._raw as any).lat = location.lat;
        (record._raw as any).lng = location.lng;
        (record._raw as any).accuracy = 5; // default accuracy fallback
        (record._raw as any).location_source = 'relay';
        (record._raw as any).severity = severity;
        (record._raw as any).status = 'open';
        (record._raw as any).assigned_rescuer_id = '';
        (record._raw as any).created_at = new Date(timestamp).getTime();
      });
    });

    // Notify listeners (screens)
    this.incomingSosSubject.next(incident);
  }
}
