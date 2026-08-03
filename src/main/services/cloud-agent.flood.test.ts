import { describe, it, expect } from 'vitest'

// ─── Parallel-safe admission control (replica of executeCommand's gate) ──
// "Parallel-safe" means a command won't corrupt state if overlapped — not that
// it's cheap. `scan` walks the whole disk. Before this gate existed, parallel-
// safe commands had neither a concurrency cap nor a rate limit, so anything
// able to send commands could pin the device's CPU and I/O just by repeating
// one. That is reachable by a hostile key holder, and equally by a dashboard
// retrying too eagerly.

const MAX_PARALLEL_COMMANDS = 4
const PARALLEL_COMMAND_MIN_SPACING_MS = 1000
const MUTATING_MIN_SPACING_MS = 500

interface GateState {
  runningCommands: number
  commandRunning: boolean
  lastCommandFinishedAt: number
  lastParallelStartAt: Map<string, number>
}

function newState(overrides: Partial<GateState> = {}): GateState {
  return {
    runningCommands: 0,
    commandRunning: false,
    lastCommandFinishedAt: 0,
    lastParallelStartAt: new Map(),
    ...overrides,
  }
}

/** Returns the rejection reason, or null if the command is admitted. */
function admit(state: GateState, type: string, isParallelSafe: boolean, now: number): string | null {
  if (!isParallelSafe && state.commandRunning) return 'A mutating command is already running'
  if (!isParallelSafe && state.runningCommands > 0) return 'Commands are still running — try again shortly'
  if (isParallelSafe && state.runningCommands >= MAX_PARALLEL_COMMANDS) {
    return 'Too many commands running — try again shortly'
  }
  if (!isParallelSafe) {
    if (now - state.lastCommandFinishedAt < MUTATING_MIN_SPACING_MS) return 'Rate limited — try again shortly'
  } else {
    const lastStart = state.lastParallelStartAt.get(type) ?? 0
    if (now - lastStart < PARALLEL_COMMAND_MIN_SPACING_MS) return 'Rate limited — try again shortly'
    state.lastParallelStartAt.set(type, now)
  }
  if (!isParallelSafe) state.commandRunning = true
  state.runningCommands++
  return null
}

describe('parallel-safe command admission', () => {
  const T = 10_000_000

  it('admits a scan when the device is idle', () => {
    expect(admit(newState(), 'scan', true, T)).toBeNull()
  })

  it('caps how many parallel-safe commands run at once', () => {
    const state = newState({ runningCommands: MAX_PARALLEL_COMMANDS })
    expect(admit(state, 'scan', true, T)).toMatch(/Too many commands running/)
  })

  it('rejects a flood of repeated scans instead of stacking them', () => {
    const state = newState()
    const outcomes = Array.from({ length: 20 }, (_, i) => admit(state, 'scan', true, T + i))
    expect(outcomes.filter((o) => o === null)).toHaveLength(1)
    expect(state.runningCommands).toBe(1)
  })

  it('spaces out repeats of the same command type', () => {
    const state = newState()
    expect(admit(state, 'scan', true, T)).toBeNull()
    state.runningCommands = 0 // first one finished
    expect(admit(state, 'scan', true, T + 100)).toMatch(/Rate limited/)
    expect(admit(state, 'scan', true, T + PARALLEL_COMMAND_MIN_SPACING_MS)).toBeNull()
  })

  it('keys the spacing per type, so scans do not crowd out get-status', () => {
    const state = newState()
    expect(admit(state, 'scan', true, T)).toBeNull()
    expect(admit(state, 'get-status', true, T)).toBeNull()
  })

  it('still admits a mutating command when nothing is running', () => {
    expect(admit(newState({ lastCommandFinishedAt: 0 }), 'clean', false, T)).toBeNull()
  })

  it('leaves the mutating exclusive lock intact', () => {
    const state = newState({ commandRunning: true })
    expect(admit(state, 'clean', false, T)).toMatch(/already running/)
  })

  it('does not let the parallel cap block mutating commands, which have their own gate', () => {
    // runningCommands > 0 already rejects mutating work, so the cap must not be
    // the thing deciding it — otherwise the message would be wrong.
    const state = newState({ runningCommands: MAX_PARALLEL_COMMANDS })
    expect(admit(state, 'clean', false, T)).toMatch(/still running/)
  })
})

// ─── Slot accounting across a timeout ───────────────────────────
// Timing out gives up waiting for a result; it does not stop the work. If the
// timeout released the slot, every timeout would admit another batch while the
// previous one still ran, and real concurrency would drift past the ceiling.
// The slot is therefore released only when the operation settles.

interface Slots {
  running: number
  release(): void
  onTimeout(): void
}

function slots(): Slots {
  const s = {
    running: 0,
    release() { s.running = Math.max(0, s.running - 1) },
    onTimeout() { /* reports the failure; deliberately does not release */ },
  }
  return s
}

describe('command slot accounting', () => {
  it('keeps the slot held when a command times out', () => {
    const s = slots()
    s.running++
    s.onTimeout()
    expect(s.running).toBe(1)
  })

  it('releases the slot when the timed-out command finally settles', () => {
    const s = slots()
    s.running++
    s.onTimeout()
    s.release()
    expect(s.running).toBe(0)
  })

  it('releases exactly once, so a timeout plus settle cannot double-count', () => {
    const s = slots()
    s.running += 2
    s.onTimeout() // command A times out, still running
    s.release()   // command B settles
    expect(s.running).toBe(1)
  })

  it('does not let repeated timeouts open unlimited slots', () => {
    const s = slots()
    for (let i = 0; i < MAX_PARALLEL_COMMANDS; i++) {
      s.running++
      s.onTimeout()
    }
    const state = newState({ runningCommands: s.running })
    expect(admit(state, 'scan', true, 10_000_000)).toMatch(/Too many commands running/)
  })
})
