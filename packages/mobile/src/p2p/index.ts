import { MessageRouter } from './MessageRouter';
import { meshTransport } from '../nearby';

export const messageRouter = new MessageRouter(meshTransport);

export { MessageRouter, PeerSession } from './MessageRouter';
export { DedupCache } from './DedupCache';
export { createEnvelope, serializeEnvelope, deserializeEnvelope } from './MessageEnvelope';
export { keyManager, keyExchange } from '../crypto';
export { ConversationManager } from './ConversationManager';
export { sendImage } from './ImageSender';
export { chunkFile } from './ImageChunker';
export { subscribeChunkProgress, subscribeImageComplete, receiveChunk } from './ChunkAssembler';
