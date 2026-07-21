import { Q } from '@nozbe/watermelondb';
import { database } from '../db';
import { MediaChunk, MediaTransfer, Message } from '../db/models';
import { writeBase64ToCache } from '../utils/mediaCache';
import { logm, errm } from '../utils/logger';

const TAG = 'CHUNK_ASM';

export type ChunkProgressCallback = (
  recordId: string,
  received: number,
  total: number,
) => void;

export type ImageCompleteCallback = (
  recordId: string,
  localUri: string,
  messageId: string,
) => void;

const progressCallbacks = new Set<ChunkProgressCallback>();
const completeCallbacks = new Set<ImageCompleteCallback>();
const reassembled = new Set<string>();

export function subscribeChunkProgress(cb: ChunkProgressCallback): () => void {
  progressCallbacks.add(cb);
  return () => progressCallbacks.delete(cb);
}

export function subscribeImageComplete(cb: ImageCompleteCallback): () => void {
  completeCallbacks.add(cb);
  return () => completeCallbacks.delete(cb);
}

export async function receiveChunk(
  recordId: string,
  chunkIndex: number,
  chunkTotal: number,
  chunkData: string,
  fileName?: string,
  mimeType?: string,
  fileSize?: number,
): Promise<void> {
  try {
    // Skip if this chunk (recordId + chunkIndex) already exists
    const existing = await database.get<MediaChunk>('media_chunks')
      .query(
        Q.where('record_id', recordId),
        Q.where('chunk_index', chunkIndex),
      )
      .fetch();

    if (existing.length > 0) {
      logm(TAG, `Duplicate chunk ${recordId}[${chunkIndex}], skipping`);
      return;
    }

    await database.write(async () => {
      await database.get<MediaChunk>('media_chunks').create((mc) => {
        mc.recordId = recordId;
        mc.recordType = 'message';
        mc.chunkIndex = chunkIndex;
        mc.chunkTotal = chunkTotal;
        mc.data = chunkData;
        mc.nonce = '';
        mc.fileName = fileName || '';
        mc.mimeType = mimeType || '';
        mc.fileSize = fileSize || 0;
      });
    });

    const existingTransfers = await database.get<MediaTransfer>('media_transfers')
      .query(Q.where('record_id', recordId))
      .fetch();

    if (existingTransfers.length > 0) {
      await database.write(async () => {
        await existingTransfers[0].update((t) => {
          t.receivedChunks = t.receivedChunks + 1;
        });
      });
    } else {
      await database.write(async () => {
        await database.get<MediaTransfer>('media_transfers').create((t) => {
          t.recordId = recordId;
          t.messageId = '';
          t.fileName = fileName || 'unknown';
          t.mimeType = mimeType || 'application/octet-stream';
          t.fileSize = fileSize || 0;
          t.totalChunks = chunkTotal;
          t.receivedChunks = 1;
          t.status = 'receiving';
        });
      });
    }

    const transfer = await database.get<MediaTransfer>('media_transfers')
      .query(Q.where('record_id', recordId))
      .fetch();

    if (transfer.length > 0) {
      const received = transfer[0].receivedChunks;
      progressCallbacks.forEach((cb) => cb(recordId, received, chunkTotal));
    }

    const allChunks = await database.get<MediaChunk>('media_chunks')
      .query(
        Q.where('record_id', recordId),
        Q.sortBy('chunk_index', 'asc'),
      )
      .fetch();

    const uniqueIndices = new Set(allChunks.map((c) => c.chunkIndex));
    if (uniqueIndices.size >= chunkTotal && !reassembled.has(recordId)) {
      reassembled.add(recordId);
      await reassemble(recordId, allChunks);
    }
  } catch (err: any) {
    errm(TAG, `receiveChunk failed for ${recordId} chunk ${chunkIndex}`, err);
  }
}

async function reassemble(recordId: string, chunks: MediaChunk[]): Promise<void> {
  try {
    const ordered = chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
    let fullBase64 = '';
    for (const c of ordered) {
      fullBase64 += c.data;
    }

    const fileName = chunks[0]?.fileName || `image-${recordId}.jpg`;
    const mimeType = chunks[0]?.mimeType || 'image/jpeg';

    const localUri = await writeBase64ToCache(fullBase64, fileName);

    await database.write(async () => {
      const transfers = await database.get<MediaTransfer>('media_transfers')
        .query(Q.where('record_id', recordId))
        .fetch();

      if (transfers.length > 0) {
        await transfers[0].update((t) => {
          t.localUri = localUri;
          t.status = 'complete';
        });
      }
    });

    logm(TAG, `Reassembled ${recordId} → ${localUri}`);

    const messageId = `msg_${recordId}`;
    completeCallbacks.forEach((cb) => cb(recordId, localUri, messageId));
  } catch (err: any) {
    errm(TAG, `reassemble failed for ${recordId}`, err);

    await database.write(async () => {
      const transfers = await database.get<MediaTransfer>('media_transfers')
        .query(Q.where('record_id', recordId))
        .fetch();

      if (transfers.length > 0) {
        await transfers[0].update((t) => {
          t.status = 'failed';
        });
      }
    });
  }
}
