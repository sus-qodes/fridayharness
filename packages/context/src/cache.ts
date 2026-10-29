import type { ContextExplanation, ContextPacket } from '@friday/protocol';

/** The last compiled packets by cache key (ADR-0022 §7). In memory: a restart simply recompiles. */
export class ContextCache {
  private readonly entries = new Map<string, { packet: ContextPacket; explanation: ContextExplanation }>();

  constructor(private readonly capacity = 100) {}

  get(key: string): { packet: ContextPacket; explanation: ContextExplanation } | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: { packet: ContextPacket; explanation: ContextExplanation }): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
