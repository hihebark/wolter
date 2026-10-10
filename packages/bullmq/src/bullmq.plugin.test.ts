import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '@wolter/core';
import { BullMQPlugin, BullMQPluginOptions } from './bullmq.plugin';

// register() opens real QueueEvents (Redis) connections, so these tests drive
// the finished-job handler directly with a fake queue instead.
type Job = { processedOn?: number; finishedOn?: number } | undefined;
function fakeQueue(name: string, getJob: (id: string) => Promise<Job>) {
  return { name, getJob } as never;
}

async function finish(options: Partial<BullMQPluginOptions>, queue: never, outcome: 'completed' | 'failed') {
  const recorded: Array<{ label: string; status: string; duration?: number }> = [];
  const plugin = new BullMQPlugin({ queues: [], ...options });
  (plugin as unknown as { recorder: Recorder }).recorder = {
    record: (e: { label: string; status: string; duration?: number }) => recorded.push({ label: e.label, status: e.status, duration: e.duration }),
  } as unknown as Recorder;
  await (plugin as unknown as { onFinished(q: never, id: string, o: string): Promise<void> }).onFinished(queue, '1', outcome);
  return recorded;
}

test('a completed job is recorded with its processing duration', async () => {
  const recorded = await finish({}, fakeQueue('emails', async () => ({ processedOn: 1_000, finishedOn: 1_250 })), 'completed');
  assert.deepEqual(recorded, [{ label: 'emails', status: 'ok', duration: 250 }]);
});

test('a job over its queue threshold is slow; the default applies to other queues', async () => {
  const thresholds = { default: 1_000, queues: { emails: 100 } };
  const job = async () => ({ processedOn: 0, finishedOn: 250 });
  assert.equal((await finish({ thresholds }, fakeQueue('emails', job), 'completed'))[0].status, 'slow');
  assert.equal((await finish({ thresholds }, fakeQueue('reports', job), 'completed'))[0].status, 'ok');
});

test('without any threshold, a long job is not marked slow', async () => {
  const recorded = await finish({}, fakeQueue('emails', async () => ({ processedOn: 0, finishedOn: 3_600_000 })), 'completed');
  assert.equal(recorded[0].status, 'ok');
});

test('a failed job is an error and keeps its duration', async () => {
  const recorded = await finish({ thresholds: { default: 1 } }, fakeQueue('emails', async () => ({ processedOn: 0, finishedOn: 50 })), 'failed');
  assert.deepEqual(recorded, [{ label: 'emails', status: 'error', duration: 50 }]);
});

test('a removed job, or a failing lookup, is still counted, without a duration', async () => {
  const removed = await finish({ thresholds: { default: 1 } }, fakeQueue('emails', async () => undefined), 'completed');
  assert.deepEqual(removed, [{ label: 'emails', status: 'ok', duration: undefined }]);
  const broken = await finish({}, fakeQueue('emails', async () => { throw new Error('ECONNRESET'); }), 'failed');
  assert.deepEqual(broken, [{ label: 'emails', status: 'error', duration: undefined }]);
});
