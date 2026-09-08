/**
 * Thread-selection rules for the studio chat runtime (GOAL-345).
 *
 * Pure decision logic, extracted from `studio-shell.tsx` so it can be asserted
 * directly — the shell itself is a React tree the node test environment can't
 * mount.
 *
 * The product rule these encode: **every initial load of the studio opens on an
 * empty conversation.** Previous threads stay one tap away in the switcher, but
 * nothing is replayed on top of the member on arrival. This deliberately
 * reverses GOAL-240's restore-on-refresh behaviour for initial load only;
 * in-session thread switching and the post-upload auto-switch are unchanged.
 */

/**
 * Runtime key for the empty landing conversation — the state every initial
 * load starts in, before any thread has been picked or created.
 */
export const LANDING_THREAD_KEY = 'new'

/**
 * The thread the chat runtime should mount against for a given runtime key.
 * `undefined` means the landing conversation: no thread, nothing to hydrate.
 */
export function mountedThreadIdFor(threadKey: string): string | undefined {
  return threadKey === LANDING_THREAD_KEY ? undefined : threadKey
}

/**
 * Whether the runtime should mount straight into an empty conversation instead
 * of fetching turns.
 *
 * True in two cases:
 *   - the landing conversation, which has no thread at all; and
 *   - a thread we just created client-side, which is known to have no turns —
 *     fetching it is wasted work and the loading flash is pure noise.
 */
export function shouldSkipHydration(
  mountedThreadId: string | undefined,
  freshThreadId: string | null
): boolean {
  if (!mountedThreadId) return true
  return mountedThreadId === freshThreadId
}

/**
 * Which thread id an outgoing turn must carry, and whether one has to be
 * created first.
 *
 * `needsCreate` is the guard against the first-send trap: `appendConversationTurn`
 * with no threadId MERGEs onto the member's implicit `ownerId`-keyed thread —
 * their oldest conversation, with all its history. A turn sent from the landing
 * state without an explicit id would be silently buried there while the panel
 * showed only the message they just typed. So the landing state's first send
 * creates a thread immediately before dispatch; every later send in the same
 * session reuses it.
 */
export function resolveOutgoingThreadId(input: {
  /** The thread this runtime was mounted against, if any. */
  mountedThreadId?: string
  /** A thread this runtime already created for the landing conversation. */
  lazyThreadId?: string | null
}): { threadId?: string; needsCreate: boolean } {
  const threadId = input.mountedThreadId ?? input.lazyThreadId ?? undefined
  return { threadId, needsCreate: !threadId }
}
