import { Aggregator } from './aggregation/aggregator';
import { EventLog } from './aggregation/event-log';
import { WolterEvent } from './interfaces/event.interface';

export class Recorder {
  constructor(private aggregator: Aggregator, private eventLog: EventLog) {}

  record(event: WolterEvent): void {
    try {
      this.aggregator.ingest(event);
      this.eventLog.record(event);
    } catch {
      // Zero-impact guarantee: a broken watcher/plugin must never affect the host app.
    }
  }
}
