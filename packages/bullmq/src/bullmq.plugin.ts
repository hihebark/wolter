import { Recorder, WolterPlugin } from '@wolter/core';
import { Queue, QueueEvents } from 'bullmq';

export interface BullMQPluginOptions {
  queues: Queue[];
}

// ponytail: groups by queue name only, not queue+job-name — BullMQ's
// QueueEvents payloads for completed/failed/stalled only carry a jobId, and
// resolving the job name would mean an extra queue.getJob() round trip per
// event. Add per-job-name grouping if per-queue isn't granular enough.
export class BullMQPlugin implements WolterPlugin {
  name = 'bullmq';
  category: WolterPlugin['category'] = 'job';

  private recorder?: Recorder;
  private queueEvents: QueueEvents[] = [];

  constructor(private readonly options: BullMQPluginOptions) {}

  register(recorder: Recorder): void {
    this.recorder = recorder;
    for (const queue of this.options.queues) {
      const events = new QueueEvents(queue.name, { connection: queue.opts.connection });
      events.on('completed', () => this.emit(queue.name, 'ok'));
      events.on('failed', () => this.emit(queue.name, 'error'));
      events.on('stalled', () => this.emit(queue.name, 'slow'));
      this.queueEvents.push(events);
    }
  }

  async deregister(): Promise<void> {
    await Promise.all(this.queueEvents.map((e) => e.close()));
    this.recorder = undefined;
  }

  private emit(queueName: string, status: 'ok' | 'error' | 'slow'): void {
    if (!this.recorder) return; // not registered yet
    try {
      this.recorder.record({
        plugin: this.name,
        category: 'job',
        label: queueName,
        status,
        timestamp: Date.now(),
      });
    } catch {
      // Zero-impact guarantee.
    }
  }
}
