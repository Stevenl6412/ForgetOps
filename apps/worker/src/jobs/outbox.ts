export interface OutboxEvent {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  publishedAt: string | null;
}

export interface OutboxStore {
  claim(limit: number): Promise<OutboxEvent[]> | OutboxEvent[];
  markPublished(id: string, publishedAt: string): Promise<void> | void;
}

export interface OutboxPublisherOptions {
  publish(event: OutboxEvent): Promise<void> | void;
  now?: () => Date;
  batchSize?: number;
}

export class OutboxPublisher {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(
    private readonly store: OutboxStore,
    private readonly options: OutboxPublisherOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 100;
    if (this.batchSize <= 0 || this.batchSize > 1000) {
      throw new RangeError("OUTBOX_BATCH_SIZE_INVALID");
    }
  }

  async runOnce(): Promise<number> {
    const events = await this.store.claim(this.batchSize);
    let published = 0;
    for (const event of events) {
      await this.options.publish(event);
      await this.store.markPublished(event.id, this.now().toISOString());
      published += 1;
    }
    return published;
  }
}
