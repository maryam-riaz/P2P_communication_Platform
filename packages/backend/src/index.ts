/**
 * Backend entry point for the SOSIFY (Disaster P2P Monorepo) gateway server.
 * 
 * This module bootstraps the PostgreSQL, MongoDB, and Redis connections
 * and exposes core repository instances and schema definitions.
 */

export { ServerRepository } from './db/repository';
export { createRedisClient, RedisKeys } from './cache/redis-config';
export type { MongoMessageDocument } from './db/mongo-schema';

console.log('SOSIFY Backend Gateway — core modules loaded successfully.');
