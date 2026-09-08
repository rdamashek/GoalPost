import {
  LANDING_THREAD_KEY,
  mountedThreadIdFor,
  resolveOutgoingThreadId,
  shouldSkipHydration,
} from './chat-thread-selection'

/**
 * GOAL-345 — the chat panel opens on an empty conversation on every initial
 * load. These assert the decision logic the studio shell drives its runtime
 * with; the browser-level behaviour is covered by the e2e pass.
 */
describe('chat thread selection (GOAL-345)', () => {
  describe('cold load opens empty', () => {
    it('mounts no thread on an initial load', () => {
      expect(mountedThreadIdFor(LANDING_THREAD_KEY)).toBeUndefined()
    })

    it('skips hydration on an initial load, so no prior thread is replayed', () => {
      const mounted = mountedThreadIdFor(LANDING_THREAD_KEY)
      expect(shouldSkipHydration(mounted, null)).toBe(true)
    })

    it('still skips hydration when the member has a previously pinned thread', () => {
      // The pin is retired, but even a stale freshThreadId must not pull the
      // landing conversation into hydrating something.
      expect(shouldSkipHydration(undefined, 'thread_old_ingest')).toBe(true)
    })
  })

  describe('history remains reachable', () => {
    it('mounts and hydrates a thread the member explicitly picked', () => {
      const mounted = mountedThreadIdFor('thread_abc')
      expect(mounted).toBe('thread_abc')
      expect(shouldSkipHydration(mounted, null)).toBe(false)
    })

    it('does not hydrate a thread we just created client-side (no loading flash)', () => {
      const mounted = mountedThreadIdFor('thread_new')
      expect(shouldSkipHydration(mounted, 'thread_new')).toBe(true)
    })

    it('hydrates that same thread normally once the fresh hint is consumed', () => {
      const mounted = mountedThreadIdFor('thread_new')
      expect(shouldSkipHydration(mounted, null)).toBe(false)
    })
  })

  describe('first send never lands in the implicit reflective thread', () => {
    it('requires a thread to be created for the landing conversation first send', () => {
      const { threadId, needsCreate } = resolveOutgoingThreadId({})
      // No id at all — sending like this would MERGE onto the member's
      // ownerId-keyed thread and bury the message in old history.
      expect(threadId).toBeUndefined()
      expect(needsCreate).toBe(true)
    })

    it('reuses the lazily created thread for every later send in the session', () => {
      const { threadId, needsCreate } = resolveOutgoingThreadId({
        lazyThreadId: 'thread_lazy',
      })
      expect(threadId).toBe('thread_lazy')
      expect(needsCreate).toBe(false)
    })

    it('sends to the mounted thread when the member picked one', () => {
      const { threadId, needsCreate } = resolveOutgoingThreadId({
        mountedThreadId: 'thread_picked',
      })
      expect(threadId).toBe('thread_picked')
      expect(needsCreate).toBe(false)
    })

    it('prefers the mounted thread over a stale lazy id', () => {
      const { threadId } = resolveOutgoingThreadId({
        mountedThreadId: 'thread_picked',
        lazyThreadId: 'thread_lazy',
      })
      expect(threadId).toBe('thread_picked')
    })
  })

  describe('no graph litter', () => {
    it('creates nothing on load — a thread is only ever needed at send time', () => {
      // Five cold loads in a row: each one mounts the landing conversation and
      // asks for no thread. Nothing here can create a ConversationThread node.
      for (let i = 0; i < 5; i++) {
        const mounted = mountedThreadIdFor(LANDING_THREAD_KEY)
        expect(mounted).toBeUndefined()
        expect(shouldSkipHydration(mounted, null)).toBe(true)
      }
    })
  })
})
