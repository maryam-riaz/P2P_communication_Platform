import { messageRouter } from './index';
import { chunkFile } from './ImageChunker';
import { database } from '../db';
import { Message } from '../db/models';
import { logm, errm } from '../utils/logger';

const TAG = 'IMG_SEND';

export type ImageSendProgress = (sent: number, total: number) => void;

export async function sendImage(
  endpointId: string,
  imageUri: string,
  imageName: string,
  conversationId: string,
  mimeType: string,
  onProgress?: ImageSendProgress,
): Promise<string | null> {
  try {
    const { chunks, totalChunks, fileId, fileSize } = await chunkFile(imageUri);

    logm(TAG, `Sending ${imageName} (${totalChunks} chunks, ${fileSize} bytes) to ${endpointId}`);

    // Create a single message record for the sender's UI and capture its ID
    let senderRecordId: string | null = null;
    await database.write(async () => {
      const record = await database.get<Message>('messages').create((m) => {
        m.senderId = messageRouter.getDeviceId();
        m.receiverId = '';
        m.conversationId = conversationId;
        m.type = 'image';
        m.payload = imageUri;
        m.nonce = '';
        m.ttl = 4;
        m.status = 'pending';
      });
      senderRecordId = record.id;
    });

    for (let i = 0; i < totalChunks; i++) {
      const chunk = chunks[i];

      await messageRouter.sendToPeer(endpointId, 'IMAGE', chunk, {
        messageId: fileId,
        chunkIndex: i,
        chunkTotal: totalChunks,
        conversationId,
      });

      logm(TAG, `Sent chunk ${i + 1}/${totalChunks} for ${fileId}`);
      onProgress?.(i + 1, totalChunks);
    }

    // Update sender's message to 'sent' using the captured record ID
    if (senderRecordId) {
      await database.write(async () => {
        const record = await database.get<Message>('messages').find(senderRecordId);
        await record.update((m) => { m.status = 'sent'; });
      });
    }

    logm(TAG, `Sent ${imageName} successfully (${totalChunks} chunks)`);
    return fileId;
  } catch (err: any) {
    errm(TAG, `sendImage failed for ${imageName}`, err);
    return null;
  }
}
