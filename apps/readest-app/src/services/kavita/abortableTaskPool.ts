interface TaskWaiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason?: unknown) => void;
  onAbort: () => void;
}

export class AbortableTaskPool {
  private active = 0;
  private readonly waiters: TaskWaiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Task pool limit must be positive');
  }

  private release = (): void => {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  };

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(new DOMException('Aborted', 'AbortError'));
        continue;
      }
      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.release();
      });
    }
  }

  private async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.release();
      };
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: TaskWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await task();
    } finally {
      release();
    }
  }
}
