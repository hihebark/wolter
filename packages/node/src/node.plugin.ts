import { Recorder, WolterPlugin } from '@wolter/core';
import { monitorEventLoopDelay, IntervalHistogram } from 'node:perf_hooks';

export interface NodePluginOptions {
  /** Poll interval in ms. Default 10s. */
  interval?: number;
}

// ponytail: three gauges (cpu %, heap MB, event loop lag ms) reuse the same
// count/duration aggregation as every other category by treating each poll
// as an "event" per metric, with duration = the sampled value — the existing
// p50/p95/max machinery gives free percentiles over time for a gauge without
// any new storage columns. All stdlib: no new dependency for CPU/heap/lag.
export class NodePlugin implements WolterPlugin {
  name = 'node';
  category: WolterPlugin['category'] = 'runtime';

  private recorder?: Recorder;
  private timer?: NodeJS.Timeout;
  private lagHistogram?: IntervalHistogram;
  private lastCpuUsage = process.cpuUsage();
  private lastSampleTime = Date.now();

  constructor(private readonly options: NodePluginOptions = {}) {}

  register(recorder: Recorder): void {
    this.recorder = recorder;
    this.lagHistogram = monitorEventLoopDelay({ resolution: 20 });
    this.lagHistogram.enable();

    const interval = this.options.interval ?? 10_000;
    this.timer = setInterval(() => this.poll(), interval);
    this.timer.unref?.();
  }

  deregister(): void {
    if (this.timer) clearInterval(this.timer);
    this.lagHistogram?.disable();
    this.recorder = undefined;
  }

  private poll(): void {
    if (!this.recorder) return;
    try {
      const now = Date.now();
      const elapsedMs = now - this.lastSampleTime;
      const cpu = process.cpuUsage(this.lastCpuUsage);
      const cpuPercent = elapsedMs > 0 ? ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100 : 0;
      this.lastCpuUsage = process.cpuUsage();
      this.lastSampleTime = now;

      const heapUsedMB = process.memoryUsage().heapUsed / (1024 * 1024);

      const lagMs = this.lagHistogram ? this.lagHistogram.mean / 1e6 : 0;
      this.lagHistogram?.reset();

      this.emit('cpu', cpuPercent);
      this.emit('heap', heapUsedMB);
      this.emit('eventLoopLag', Number.isFinite(lagMs) ? lagMs : 0);
    } catch {
      // Zero-impact guarantee.
    }
  }

  private emit(label: string, value: number): void {
    try {
      this.recorder!.record({
        plugin: this.name,
        category: 'runtime',
        label,
        duration: value,
        status: 'ok',
        timestamp: Date.now(),
      });
    } catch {
      // Zero-impact guarantee.
    }
  }
}
