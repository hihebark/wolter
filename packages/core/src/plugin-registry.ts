import { WolterPlugin } from './interfaces/plugin.interface';
import { Recorder } from './recorder';

export interface PluginStatus {
  name: string;
  category: string;
  active: boolean;
  error?: string;
}

export class PluginRegistry {
  // Keyed by plugin name so bootstrap()'s outcome (active or the error that
  // stopped registration) is queryable afterward — previously a failed
  // register() only reached console.error, invisible to the dashboard.
  private statuses = new Map<string, PluginStatus>();

  constructor(private plugins: WolterPlugin[], private recorder: Recorder) {}

  async bootstrap(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.register(this.recorder);
        this.statuses.set(plugin.name, { name: plugin.name, category: plugin.category, active: true });
      } catch (err) {
        this.statuses.set(plugin.name, {
          name: plugin.name,
          category: plugin.category,
          active: false,
          error: err instanceof Error ? err.message : String(err),
        });
        // A misbehaving plugin must not stop the app from starting.
        // eslint-disable-next-line no-console
        console.error(`[Wolter] Plugin "${plugin.name}" failed to register:`, err);
      }
    }
  }

  status(): PluginStatus[] {
    return [...this.statuses.values()];
  }

  async shutdown(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      try {
        await plugin.deregister();
      } catch {
        // Never block shutdown on a plugin cleanup failure.
      }
    }
  }
}
