import { readFileAsBase64, getFileInfo } from '../utils/mediaCache';

export interface ChunkResult {
  chunks: string[];
  totalChunks: number;
  fileId: string;
  fileSize: number;
}

const DEFAULT_CHUNK_SIZE = 128 * 1024;

export async function chunkFile(
  uri: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<ChunkResult> {
  const base64 = await readFileAsBase64(uri);
  const fileInfo = await getFileInfo(uri);
  const totalChunks = Math.ceil(base64.length / chunkSize);
  const chunks: string[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, base64.length);
    chunks.push(base64.slice(start, end));
  }

  const fileId = `img_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  return {
    chunks,
    totalChunks,
    fileId,
    fileSize: fileInfo.size,
  };
}
