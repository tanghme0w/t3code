/**
 * ThreadForkReactor - Thread fork side-effect reactor service interface.
 *
 * Owns background workers that react to `thread.forked` domain events and
 * seed the forked thread's provider resume state (so the provider session
 * forks the source conversation instead of starting cold).
 *
 * @module ThreadForkReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadForkReactorShape - Service API for thread fork side effects.
 */
export interface ThreadForkReactorShape {
  /**
   * Start reacting to thread.forked orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadForkReactor - Service tag for thread fork side-effect workers.
 */
export class ThreadForkReactor extends Context.Service<ThreadForkReactor, ThreadForkReactorShape>()(
  "t3/orchestration/Services/ThreadForkReactor",
) {}
