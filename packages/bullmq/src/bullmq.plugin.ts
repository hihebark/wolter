import { Recorder, WolterPlugin } from '@wolter/core';
import { Queue, QueueEvents } from 'bullmq';

export interface BullMQPluginOptions {
  queues: Queue[];
  /** When a finished job counts as slow (ms, from start of processing to finish). `default`
   *  applies to every queue; `queues` overrides it per queue name. With neither set, jobs are
   *  only marked slow when BullMQ reports them stalled. */
  thresholds?: {
    default?: number;
    queues?: Record<string, number>;
  };
}

type Outcome = 'completed' | 'failed';

// ponytail: groups by queue name only, not queue+job-name — job names are set
// by whatever code enqueues jobs and can be dynamic, so per-name groups aren't
// a safe default. Add opt-in per-name grouping if per-queue isn't granular enough.
//
// Durations: QueueEvents payloads only carry a jobId, so each completed/failed
// event costs one queue.getJob() round trip to read processedOn/finishedOn.
// A job already removed by then (removeOnComplete/removeOnFail) is still
// counted, just without a duration.
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
      events.on('completed', ({ jobId }) => void this.onFinished(queue, jobId, 'completed'));
      events.on('failed', ({ jobId }) => void this.onFinished(queue, jobId, 'failed'));
      events.on('stalled', () => this.emit(queue.name, 'slow'));
      this.queueEvents.push(events);
    }
  }

  async deregister(): Promise<void> {
    await Promise.all(this.queueEvents.map((e) => e.close()));
    this.recorder = undefined;
  }

  private async onFinished(queue: Pick<Queue, 'name' | 'getJob'>, jobId: string, outcome: Outcome): Promise<void> {
    let duration: number | undefined;
    try {
      const job = await queue.getJob(jobId);
      if (typeof job?.processedOn === 'number' && typeof job.finishedOn === 'number') duration = job.finishedOn - job.processedOn;
    } catch {
      // Redis hiccup or a removed job — still count the event, without timing.
    }
    const threshold = this.options.thresholds?.queues?.[queue.name] ?? this.options.thresholds?.default;
    const status = outcome === 'failed' ? 'error' : threshold !== undefined && duration !== undefined && duration > threshold ? 'slow' : 'ok';
    this.emit(queue.name, status, duration);
  }

  private emit(queueName: string, status: 'ok' | 'error' | 'slow', duration?: number): void {
    if (!this.recorder) return; // not registered yet
    try {
      this.recorder.record({
        plugin: this.name,
        category: 'job',
        label: queueName,
        duration,
        status,
        timestamp: Date.now(),
      });
    } catch {
      // Zero-impact guarantee.
    }
  }
}
