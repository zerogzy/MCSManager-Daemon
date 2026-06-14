interface LockEntry {
  locked: boolean;
  queue: Array<{
    resolve: (release: () => void) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

class MemoryLock {
  private lockMap = new Map<string, LockEntry>();

  async acquire(key: string, timeout: number = 10000): Promise<() => void> {
    let entry = this.lockMap.get(key);
    if (!entry) {
      entry = { locked: false, queue: [] };
      this.lockMap.set(key, entry);
    }

    if (!entry.locked) {
      entry.locked = true;
      return () => this.release(key);
    }

    // Already locked, wait in queue
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue on timeout
        const idx = entry!.queue.findIndex((q) => q.resolve === resolve);
        if (idx !== -1) entry!.queue.splice(idx, 1);
        reject(new Error(`Lock timeout for key: ${key}`));
      }, timeout);

      entry!.queue.push({ resolve, timer });
    });
  }

  private release(key: string) {
    const entry = this.lockMap.get(key);
    if (!entry) return;

    if (entry.queue.length > 0) {
      const next = entry.queue.shift()!;
      clearTimeout(next.timer);
      next.resolve(() => this.release(key));
    } else {
      entry.locked = false;
      // Clean up empty entries
      this.lockMap.delete(key);
    }
  }

  isLocked(key: string): boolean {
    const entry = this.lockMap.get(key);
    return entry?.locked ?? false;
  }
}

export const shopLock = new MemoryLock();
