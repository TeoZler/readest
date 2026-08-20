import { describe, expect, it, vi } from 'vitest';
import { AbortableTaskPool } from '@/services/kavita/abortableTaskPool';

describe('AbortableTaskPool', () => {
  it('does not let a cancelled waiter strand later work', async () => {
    const pool = new AbortableTaskPool(1);
    let releaseFirst!: () => void;
    const first = pool.run(
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const cancelled = new AbortController();
    const cancelledTask = pool.run(cancelled.signal, async () => undefined);
    const finalTask = vi.fn(async () => 'done');
    const final = pool.run(new AbortController().signal, finalTask);

    cancelled.abort();
    await expect(cancelledTask).rejects.toMatchObject({ name: 'AbortError' });
    expect(finalTask).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(final).resolves.toBe('done');
    expect(finalTask).toHaveBeenCalledOnce();
  });

  it('never exceeds its concurrency limit', async () => {
    const pool = new AbortableTaskPool(2);
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 8 }, () =>
      pool.run(new AbortController().signal, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(maximum).toBe(2);
  });
});
