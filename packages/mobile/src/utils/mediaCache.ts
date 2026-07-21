import * as FileSystem from 'expo-file-system/legacy';

const MESH_IMAGES_DIR = FileSystem.cacheDirectory + 'mesh-images/';

export async function ensureCacheDir(): Promise<void> {
  const dirInfo = await FileSystem.getInfoAsync(MESH_IMAGES_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(MESH_IMAGES_DIR, { intermediates: true });
  }
}

export function getCachePath(fileName: string): string {
  return MESH_IMAGES_DIR + fileName;
}

export async function writeBase64ToCache(base64: string, fileName: string): Promise<string> {
  await ensureCacheDir();
  const path = getCachePath(fileName);
  await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 });
  return path;
}

export async function readFileAsBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}

export async function getFileInfo(uri: string): Promise<{ size: number; exists: boolean }> {
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  if (info.exists) {
    return { size: info.size ?? 0, exists: true };
  }
  return { size: 0, exists: false };
}

export async function evictOldImages(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  await ensureCacheDir();
  const files = await FileSystem.readDirectoryAsync(MESH_IMAGES_DIR);
  const now = Date.now();

  for (const file of files) {
    const path = getCachePath(file);
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists && info.modificationTime) {
      const age = now - info.modificationTime * 1000;
      if (age > maxAgeMs) {
        await FileSystem.deleteAsync(path, { idempotent: true });
      }
    }
  }
}
