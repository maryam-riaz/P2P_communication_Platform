import { DEDUP_CACHE_MAX, DEDUP_CACHE_TTL_MS } from '../nearby/types';
import { logm } from '../utils/logger';

const TAG = 'DEDUP';

interface DedupEntry {
  messageId: string;
  addedAt: number;
}

export class DedupCache {
  private entries: DedupEntry[] = [];
  private set = new Set<string>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.sweepInterval = setInterval(() => this.sweep(), 60_000);
  }

  has(messageId: string): boolean {
    return this.set.has(messageId);
  }

  add(messageId: string): void {
    if (this.set.has(messageId)) return;
    if (this.entries.length >= DEDUP_CACHE_MAX) {
      const evicted = this.entries.shift()!;
      this.set.delete(evicted.messageId);
      logm(TAG, `Evicted oldest dedup entry: ${evicted.messageId}`);
    }
    this.entries.push({ messageId, addedAt: Date.now() });
    this.set.add(messageId);
  }

  clear(): void {
    this.entries = [];
    this.set.clear();
  }

  destroy(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    this.clear();
  }

  size(): number {
    return this.entries.length;
  }

  private sweep(): void {
    const now = Date.now();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => now - e.addedAt < DEDUP_CACHE_TTL_MS);
    this.set = new Set(this.entries.map((e) => e.messageId));
    if (this.entries.length !== before) {
      logm(TAG, `Sweep: ${before} → ${this.entries.length} entries`);
    }
  }
}
