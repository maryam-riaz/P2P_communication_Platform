import { MessageRouter } from './MessageRouter';
import { meshTransport } from '../nearby';

export const messageRouter = new MessageRouter(meshTransport);

export { MessageRouter } from './MessageRouter';
export { DedupCache } from './DedupCache';
export { createEnvelope, serializeEnvelope, deserializeEnvelope } from './MessageEnvelope';
export { keyManager, keyExchange } from '../crypto';
