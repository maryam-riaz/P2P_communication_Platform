import { Pool } from 'pg';
import { Db } from 'mongodb';
import { RedisClientType } from 'redis';
import { MongoMessageDocument } from './mongo-schema';
import { RedisKeys } from '../cache/redis-config';

export interface PgUser {
  id: string;
  device_id: string;
  role: 'user' | 'responder' | 'admin';
  display_name: string;
  public_key: string;
  verified: boolean;
  created_at?: Date;
}

export interface PgIncident {
  id: string;
  origin_device_id: string;
  reporter_id: string;
  location: string;
  severity: 'low' | 'medium' | 'critical';
  status: 'open' | 'assigned' | 'resolved';
  lead_rescuer_id: string | null;
  created_at?: Date;
  resolved_at?: Date | null;
}

export class ServerRepository {
  constructor(
    private pgPool: Pool,
    private mongoDb: Db | null,
    private redisClient: RedisClientType | null
  ) {}

  // ==========================================
  // PostgreSQL Operations
  // ==========================================

  async createUser(user: PgUser): Promise<PgUser> {
    const query = `
      INSERT INTO users (id, device_id, role, display_name, public_key, verified, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_TIMESTAMP))
      RETURNING *;
    `;
    const values = [user.id, user.device_id, user.role, user.display_name, user.public_key, user.verified, user.created_at || null];
    const res = await this.pgPool.query(query, values);
    return res.rows[0];
  }

  async getUser(id: string): Promise<PgUser | null> {
    const query = 'SELECT * FROM users WHERE id = $1;';
    const res = await this.pgPool.query(query, [id]);
    return res.rows[0] || null;
  }

  async createIncident(incident: PgIncident): Promise<PgIncident> {
    const query = `
      INSERT INTO incidents (id, origin_device_id, reporter_id, location, severity, status, lead_rescuer_id, created_at, resolved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), $9)
      RETURNING *;
    `;
    const values = [
      incident.id,
      incident.origin_device_id,
      incident.reporter_id,
      incident.location,
      incident.severity,
      incident.status,
      incident.lead_rescuer_id,
      incident.created_at || null,
      incident.resolved_at || null
    ];
    const res = await this.pgPool.query(query, values);
    return res.rows[0];
  }

  async updateIncidentStatus(id: string, status: 'open' | 'assigned' | 'resolved', leadRescuerId: string | null): Promise<PgIncident | null> {
    const resolvedAt = status === 'resolved' ? new Date() : null;
    const query = `
      UPDATE incidents
      SET status = $2, lead_rescuer_id = $3, resolved_at = COALESCE($4, resolved_at)
      WHERE id = $1
      RETURNING *;
    `;
    const res = await this.pgPool.query(query, [id, status, leadRescuerId, resolvedAt]);
    return res.rows[0] || null;
  }

  async listIncidents(filters: { status?: string; severity?: string }): Promise<PgIncident[]> {
    let query = 'SELECT * FROM incidents WHERE 1=1';
    const values: any[] = [];
    let paramCounter = 1;

    if (filters.status) {
      query += ` AND status = $${paramCounter++}`;
      values.push(filters.status);
    }
    if (filters.severity) {
      query += ` AND severity = $${paramCounter++}`;
      values.push(filters.severity);
    }

    query += ' ORDER BY created_at DESC;';
    const res = await this.pgPool.query(query, values);
    return res.rows;
  }

  async insertMessageArchive(msg: {
    id: string;
    sender_id: string;
    recipient_id: string | null;
    content_hash: string;
    encrypted_payload: string;
    origin_hop_count: number;
    created_at?: Date;
  }): Promise<any> {
    const query = `
      INSERT INTO messages_archive (id, sender_id, recipient_id, content_hash, encrypted_payload, origin_hop_count, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_TIMESTAMP))
      ON CONFLICT (content_hash) DO NOTHING
      RETURNING *;
    `;
    const values = [msg.id, msg.sender_id, msg.recipient_id, msg.content_hash, msg.encrypted_payload, msg.origin_hop_count, msg.created_at || null];
    const res = await this.pgPool.query(query, values);
    return res.rows[0] || null;
  }

  async updateSyncVector(deviceId: string, clockValue: number): Promise<void> {
    const query = `
      INSERT INTO sync_vectors (device_id, clock_value, last_update)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (device_id) DO UPDATE
      SET clock_value = EXCLUDED.clock_value, last_update = CURRENT_TIMESTAMP;
    `;
    await this.pgPool.query(query, [deviceId, clockValue]);
  }

  async getSyncVector(deviceId: string): Promise<number | null> {
    const query = 'SELECT clock_value FROM sync_vectors WHERE device_id = $1;';
    const res = await this.pgPool.query(query, [deviceId]);
    return res.rows[0] ? res.rows[0].clock_value : null;
  }

  async logConflict(deviceId: string, description: string, resolutionStatus: string): Promise<void> {
    const crypto = require('crypto');
    const id = crypto.randomUUID();
    const query = `
      INSERT INTO conflict_log (id, device_id, conflict_description, resolution_status, created_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP);
    `;
    await this.pgPool.query(query, [id, deviceId, description, resolutionStatus]);
  }

  // ==========================================
  // MongoDB Operations (Raw Archives)
  // ==========================================

  async saveRawMessageToMongo(doc: MongoMessageDocument): Promise<void> {
    if (!this.mongoDb) return;
    const collection = this.mongoDb.collection<MongoMessageDocument>('messages');
    await collection.updateOne(
      { id: doc.id },
      { $set: doc },
      { upsert: true }
    );
  }

  async queryMongoMessages(filters: any): Promise<MongoMessageDocument[]> {
    if (!this.mongoDb) return [];
    const collection = this.mongoDb.collection<MongoMessageDocument>('messages');
    return await collection.find(filters).toArray();
  }

  // ==========================================
  // Redis Operations (Live State Cache)
  // ==========================================

  async setDeviceReachable(deviceId: string, heartbeat: number, ttlSeconds: number = 60): Promise<void> {
    if (!this.redisClient) return;
    const key = RedisKeys.deviceReachable(deviceId);
    await this.redisClient.set(key, heartbeat.toString(), {
      EX: ttlSeconds,
    });
  }

  async isDeviceReachable(deviceId: string): Promise<boolean> {
    if (!this.redisClient) return false;
    const key = RedisKeys.deviceReachable(deviceId);
    const val = await this.redisClient.get(key);
    return val !== null;
  }

  async setRescuerAvailable(rescuerId: string, status: 'available' | 'busy' | 'offline'): Promise<void> {
    if (!this.redisClient) return;
    const key = RedisKeys.rescuerAvailable(rescuerId);
    await this.redisClient.set(key, status);
  }

  async getRescuerStatus(rescuerId: string): Promise<string | null> {
    if (!this.redisClient) return null;
    const key = RedisKeys.rescuerAvailable(rescuerId);
    return await this.redisClient.get(key);
  }

  async addIncidentWatcher(incidentId: string, rescuerId: string): Promise<void> {
    if (!this.redisClient) return;
    const key = RedisKeys.incidentWatchers(incidentId);
    await this.redisClient.sAdd(key, rescuerId);
  }

  async getIncidentWatchers(incidentId: string): Promise<string[]> {
    if (!this.redisClient) return [];
    const key = RedisKeys.incidentWatchers(incidentId);
    return await this.redisClient.sMembers(key);
  }
}
