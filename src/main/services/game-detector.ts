import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ── Well-known game executables (lowercase) ────────────────────
// This list covers popular PC titles.  Users can add their own
// via the customGameProcesses setting.

const KNOWN_GAME_PROCESSES = new Set([
  // Valve / Steam
  'cs2.exe', 'csgo.exe', 'dota2.exe', 'tf_win64.exe', 'left4dead2.exe',
  'portal2.exe', 'hl2.exe', 'rust.exe', 'deadlock.exe',
  // Riot
  'valorant-win64-shipping.exe', 'league of legends.exe',
  // Blizzard / Activision
  'overwatch.exe', 'wow.exe', 'wowclassic.exe', 'diablo iv.exe',
  'hearthstone.exe', 'starcraft ii.exe',
  // Epic / Fortnite
  'fortniteclient-win64-shipping.exe', 'rocketleague.exe',
  // EA
  'apex_legends.exe', 'bf2042.exe',
  // Ubisoft
  'rainbow six.exe', 'acodyssey.exe', 'acvalhalla.exe', 'acmirage.exe',
  // Rockstar
  'gta5.exe', 'gtav.exe', 'rdr2.exe',
  // FromSoftware
  'eldenring.exe', 'darksoulsiii.exe', 'sekiro.exe', 'armoredcore6.exe',
  // CD Projekt Red
  'cyberpunk2077.exe', 'witcher3.exe',
  // Larian
  'bg3.exe', 'bg3_dx11.exe',
  // Bungie
  'destiny2.exe',
  // Digital Extremes
  'warframe.x64.exe', 'warframe.exe',
  // GGG
  'pathofexile_x64.exe', 'pathofexile.exe', 'pathofexile_x64steam.exe',
  // Battle royale / shooters
  'escapefromtarkov.exe', 'pubg-win64-shipping.exe', 'tslgame.exe',
  'callofduty.exe', 'cod.exe', 'modernwarfare.exe',
  // Recent / popular
  'palworld-win64-shipping.exe', 'helldivers2.exe', 'hogwartslegacy.exe',
  'starfield.exe', 'satisfactory.exe', 'lethalcompany.exe',
  'hades2.exe', 'hades.exe', 'hollowknight.exe',
  'fallguys_client.exe', 'amongus.exe', 'terraria.exe',
  'stardewvalley.exe', 'factorio.exe', 'noita.exe',
  'deeprockgalactic-win64-shipping.exe',
  'minecraft.windows.exe',
  'theforest.exe', 'sonsoftheforest.exe',
])

// ── Types ──────────────────────────────────────────────────────

export interface GameAutoEvent {
  type: 'game-detected' | 'game-exited'
  processName: string | null
}

export interface GameDetectorCallbacks {
  onGameDetected: (processName: string) => void
  onGameExited: () => void
}

// ── State ──────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null
let callbacks: GameDetectorCallbacks | null = null
let detectedGame: string | null = null
let pollRunning = false
/** Set when user manually deactivates while a game is detected — suppresses
 *  re-activation until that game exits. */
let suppressedGame: string | null = null

// ── Detection ──────────────────────────────────────────────────

async function getRunningProcessNames(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
      timeout: 10_000,
      windowsHide: true,
    })
    const names = new Set<string>()
    for (const line of stdout.split('\n')) {
      const match = line.match(/^"([^"]+)"/)
      if (match) names.add(match[1].toLowerCase())
    }
    return names
  } catch {
    return new Set()
  }
}

function findGame(running: Set<string>, customGameProcesses: string[]): string | null {
  for (const proc of running) {
    if (KNOWN_GAME_PROCESSES.has(proc)) return proc
  }
  for (const custom of customGameProcesses) {
    if (running.has(custom.toLowerCase())) return custom.toLowerCase()
  }
  return null
}

async function poll(customGameProcesses: string[]): Promise<void> {
  if (pollRunning || !callbacks) return
  pollRunning = true

  try {
    const running = await getRunningProcessNames()
    const game = findGame(running, customGameProcesses)

    if (game && !detectedGame) {
      // Game just appeared
      if (game === suppressedGame) return // user manually deactivated this session
      detectedGame = game
      suppressedGame = null
      try { await callbacks.onGameDetected(game) } catch { /* logged by caller */ }
    } else if (!game && detectedGame) {
      // Game just exited
      detectedGame = null
      suppressedGame = null
      try { await callbacks.onGameExited() } catch { /* logged by caller */ }
    } else if (!game && !detectedGame && suppressedGame) {
      // Suppressed game has exited — clear so a future launch can trigger again
      suppressedGame = null
    }
  } finally {
    pollRunning = false
  }
}

// ── Public API ─────────────────────────────────────────────────

export function startGameDetector(
  cbs: GameDetectorCallbacks,
  customGameProcesses: string[],
): void {
  // Preserve suppression across restarts so a settings change during a
  // suppressed session doesn't re-activate the still-running game.
  const prevSuppressed = suppressedGame
  stopGameDetector()
  callbacks = cbs
  detectedGame = null
  suppressedGame = prevSuppressed
  pollTimer = setInterval(() => poll(customGameProcesses), 10_000)
  poll(customGameProcesses)
}

export function stopGameDetector(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  callbacks = null
  detectedGame = null
  suppressedGame = null
  pollRunning = false
}

/** Call when the user manually deactivates Game Mode while auto-detect is on.
 *  Prevents re-activation until the current game exits. */
export function suppressCurrentGame(): void {
  if (detectedGame) {
    suppressedGame = detectedGame
    detectedGame = null
  }
}

/** Returns the name of the currently detected game, or null. */
export function getDetectedGame(): string | null {
  return detectedGame
}

export function isDetectorRunning(): boolean {
  return pollTimer !== null
}
