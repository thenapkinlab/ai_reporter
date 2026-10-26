// Usage limits. Per user: how many emails their assistants can have checked per 10 minutes and
// per day, so a "send me all my emails" loop stops with a clear message. Across all users: how
// many classifier requests per minute, so we stay under the account's Bedrock quota instead of
// being throttled. Counters are plain numbers in DynamoDB that expire on their own; no content.

import type { Limits } from "./config";
import { ModelBusyError, type ClassifyInput, type Classifier, type Label } from "./filter/classifier";

export interface Reservation {
  /** How many of the requested emails may be processed now (0..requested). */
  allowed: number;
  /** Which limit cut the request short, if any. */
  limitedBy: "10 minutes" | "day" | null;
  /** When the limit that applied resets. */
  resetsAt: Date | null;
  usedToday: number;
}

export function tenMinuteWindow(now: Date): number {
  return Math.floor(now.getTime() / 600000);
}

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Explains a limit to the assistant, so it can tell the user instead of retrying. */
export function limitMessage(r: Reservation, limits: Limits): string {
  const at = r.resetsAt ? r.resetsAt.toISOString().slice(11, 16) + " UTC" : "later";
  return r.limitedBy === "day"
    ? `Usage limit reached: the user's assistants can have ${limits.emailsPerDay} emails checked per day. Try again after ${at}. Don't retry before then.`
    : `Usage limit reached: ${limits.emailsPer10Min} emails per 10 minutes. Try again after ${at}. Tell the user; don't loop.`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Keeps classifier requests under `perMinute` across all users. `count(minute)` atomically
 * increments that minute's shared counter and returns the new value. When a minute is full,
 * waits for the next one, up to `maxWaitMs`; after that throws ModelBusyError.
 */
export class RateLimitedClassifier implements Classifier {
  constructor(
    private inner: Classifier,
    private count: (minute: number) => Promise<number>,
    private perMinute: number,
    private maxWaitMs = 12000, // API Gateway HTTP APIs time out at 30 s
    private now: () => number = Date.now,
    private wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private async acquire() {
    let waited = 0;
    for (;;) {
      const minute = Math.floor(this.now() / 60000);
      if ((await this.count(minute)) <= this.perMinute) return;
      const ms = (minute + 1) * 60000 - this.now() + 50;
      if (waited + ms > this.maxWaitMs) throw new ModelBusyError();
      await this.wait(ms);
      waited += ms;
    }
  }

  async classify(input: ClassifyInput): Promise<Label> {
    await this.acquire();
    return this.inner.classify(input);
  }

  async classifyBatch(inputs: ClassifyInput[]): Promise<(Label | null)[]> {
    await this.acquire();
    if (this.inner.classifyBatch) return this.inner.classifyBatch(inputs);
    return Promise.all(inputs.map((x) => this.inner.classify(x).catch(() => null)));
  }
}
