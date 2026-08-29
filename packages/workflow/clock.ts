/**
 * Vaulltcore Durable Execution — clock implementations.
 *
 * The `Clock` contract (in `contracts.ts`) abstracts time so leases and
 * deadlines are testable. This module provides:
 *  - `SystemClock`: real wall-clock + monotonic time.
 *  - `TestClock`: a controllable clock that can advance time forward in tests
 *    to simulate worker death, lease expiry, and deadline elision without
 *    waiting on real timers.
 */

/* eslint-disable max-classes-per-file */
import type { Clock } from "./contracts";

export class SystemClock implements Clock {
  private readonly baseMonotonic: number;

  constructor() {
    this.baseMonotonic = Date.now();
  }

  now(): number {
    return Date.now();
  }

  monotonicMs(): number {
    const m = globalThis.performance?.now;
    if (typeof m === "function") {
      return this.baseMonotonic + m.call(globalThis.performance);
    }
    return Date.now();
  }
}

/**
 * A deterministic, manually-advanceable clock for tests. `advance(ms)` moves
 * both wall-clock and monotonic time forward instantly; any pending
 * `setTimeout`-based lease/heartbeat timers fire through their own store.
 */
export class TestClock implements Clock {
  private wall: number;
  private monotonic: number;

  constructor(initialMs = 1_000_000) {
    this.wall = initialMs;
    this.monotonic = initialMs;
  }

  now(): number {
    return this.wall;
  }

  monotonicMs(): number {
    return this.monotonic;
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.wall += ms;
    this.monotonic += ms;
  }

  /** Set the wall clock to an absolute epoch. */
  set(now: number): void {
    this.wall = now;
  }
}
