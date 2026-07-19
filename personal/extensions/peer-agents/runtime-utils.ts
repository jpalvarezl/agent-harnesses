export interface TextCapResult {
  text: string;
  truncated: boolean;
}

export function capText(value: string, maxBytes: number): TextCapResult {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

export function capTailText(value: string, maxBytes: number): TextCapResult {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length) {
    try {
      return { text: decoder.decode(bytes.subarray(start)), truncated: true };
    } catch {
      start += 1;
    }
  }
  return { text: "", truncated: true };
}

export function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Abort-aware semaphore for bounding concurrent peer subprocesses. */
export class AsyncSemaphore {
  readonly maxConcurrency: number;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(maxConcurrency: number) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.maxConcurrency = maxConcurrency;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("Peer agent was aborted while waiting for a concurrency slot");
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return this.createRelease();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("Peer agent was aborted while waiting for a concurrency slot"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (this.queue.length > 0) {
        const waiter = this.queue.shift()!;
        waiter.signal?.removeEventListener("abort", waiter.onAbort!);
        if (waiter.signal?.aborted) {
          waiter.reject(new Error("Peer agent was aborted while waiting for a concurrency slot"));
          continue;
        }
        waiter.resolve(this.createRelease());
        return;
      }
      this.active -= 1;
    };
  }
}
