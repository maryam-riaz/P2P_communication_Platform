-- Database Schemas for PostgreSQL Server
-- disaster-resilient offline peer-to-peer (P2P) communication system

-- Drop existing tables if they exist to support idempotency
DROP TABLE IF EXISTS conflict_log CASCADE;
DROP TABLE IF EXISTS sync_vectors CASCADE;
DROP TABLE IF EXISTS messages_archive CASCADE;
DROP TABLE IF EXISTS incidents CASCADE;
DROP TABLE IF EXISTS rescuer_teams CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- 1. Users Table
-- Holds the profile, status and keying material for all network participants.
CREATE TABLE users (
    id UUID PRIMARY KEY,
    device_id UUID NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'responder', 'admin')),
    display_name VARCHAR(100) NOT NULL,
    public_key TEXT NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_device_role UNIQUE (device_id, role)
);

-- Create indexes on critical search vectors
CREATE INDEX idx_users_device_id ON users(device_id);
CREATE INDEX idx_users_created_at ON users(created_at);

-- 2. Rescuer Teams Table
-- Assigns active responders to tactical divisions or teams.
CREATE TABLE rescuer_teams (
    id UUID PRIMARY KEY,
    rescuer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_name VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('available', 'busy', 'offline')),
    CONSTRAINT unique_rescuer_team UNIQUE (rescuer_id)
);

CREATE INDEX idx_rescuer_teams_status ON rescuer_teams(status);

-- 3. Incidents Table
-- Aggregated emergency reports (SOS events) submitted by victims.
CREATE TABLE incidents (
    id UUID PRIMARY KEY,
    origin_device_id UUID NOT NULL,
    reporter_id UUID NOT NULL REFERENCES users(id),
    location VARCHAR(200) NOT NULL, -- Lat/Lng represented as string for flexibility
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'critical')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('open', 'assigned', 'resolved')),
    lead_rescuer_id UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_incidents_origin_device_id ON incidents(origin_device_id);
CREATE INDEX idx_incidents_created_at ON incidents(created_at);
CREATE INDEX idx_incidents_status ON incidents(status);

-- 4. Messages Archive Table
-- Historical server-side backup of all routed encrypted messages.
CREATE TABLE messages_archive (
    id UUID PRIMARY KEY,
    sender_id UUID NOT NULL REFERENCES users(id),
    recipient_id UUID REFERENCES users(id), -- NULL maps to broadcast message
    content_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 hex string
    encrypted_payload TEXT NOT NULL, -- AES-GCM ciphertext
    origin_hop_count INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_archive_sender_id ON messages_archive(sender_id);
CREATE INDEX idx_messages_archive_recipient_id ON messages_archive(recipient_id);
CREATE INDEX idx_messages_archive_created_at ON messages_archive(created_at);

-- 5. Sync Vectors Table
-- Monitors physical device clocks using Lamport logical clocks/vector values.
CREATE TABLE sync_vectors (
    device_id UUID PRIMARY KEY,
    clock_value INTEGER NOT NULL DEFAULT 0,
    last_update TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Conflict Log Table
-- Diagnostic trace table tracking replication conflicts and chosen resolution rules.
CREATE TABLE conflict_log (
    id UUID PRIMARY KEY,
    device_id UUID NOT NULL,
    conflict_description TEXT NOT NULL,
    resolution_status VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_conflict_log_device_id ON conflict_log(device_id);
CREATE INDEX idx_conflict_log_created_at ON conflict_log(created_at);
