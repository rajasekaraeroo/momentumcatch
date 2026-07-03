import type { FeedState } from "./feed-state";
import type { UpstoxFeedSource } from "./upstox-feed.source";

/**
 * Registry of named V3 WebSocket connections (SPEC §12.8): "A" carries the
 * broad D5 universe, "B" the full_d30 focus pool. Each source keeps its own
 * reconnect/backoff/starvation state; the manager only tracks and fans out.
 */
export class ConnectionManager {
  private readonly conns = new Map<string, { source: UpstoxFeedSource; state: FeedState }>();

  add(name: string, source: UpstoxFeedSource, initial: FeedState): void {
    this.conns.set(name, { source, state: initial });
  }

  setState(name: string, state: FeedState): void {
    const c = this.conns.get(name);
    if (c) c.state = state;
  }

  stateOf(name: string): FeedState | undefined {
    return this.conns.get(name)?.state;
  }

  states(): Record<string, string> {
    return Object.fromEntries([...this.conns].map(([n, c]) => [n, c.state]));
  }

  updateSubscriptions(name: string, add: string[], remove: string[]): void {
    this.conns.get(name)?.source.updateSubscriptions(add, remove);
  }

  async stopAll(): Promise<void> {
    for (const { source } of this.conns.values()) await source.stop();
    this.conns.clear();
  }

  get size(): number {
    return this.conns.size;
  }
}
