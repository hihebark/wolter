import { EventCategory } from './event.interface';
import { Recorder } from '../recorder';

export interface WolterPlugin {
  name: string;
  category: EventCategory;
  register(recorder: Recorder): void | Promise<void>;
  deregister(): void | Promise<void>;
}
