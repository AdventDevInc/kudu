import { randomUUID } from 'crypto'
/** Main owns item IDs; renderer acknowledges a compact token rather than an unbounded ID list. */
export class AppSpaceHandoffs {
  private readonly generations = new Map<string, string[]>()
  constructor(private readonly retire: (ids: string[]) => void) {}
  private remove(token: string): void {
    const ids = this.generations.get(token)
    if (!ids) return
    this.retire(ids)
    this.generations.delete(token)
  }
  private validate(token: unknown): asserts token is string | null {
    if (
      token !== null &&
      (typeof token !== 'string' || token.length > 100 || !this.generations.has(token))
    )
      throw new Error('Unknown app-space handoff token')
  }
  /** Supersede abandoned drafts while preserving the renderer's current reviewed plan. */
  begin(currentToken: unknown): void {
    this.validate(currentToken)
    for (const token of this.generations.keys()) if (token !== currentToken) this.remove(token)
  }
  create(ids: string[]): string {
    const token = randomUUID()
    this.generations.set(token, ids)
    return token
  }
  settle(reviewToken: unknown, retainedToken: unknown): void {
    if (typeof reviewToken !== 'string' || reviewToken.length > 100)
      throw new Error('Invalid app-space handoff token')
    // A late cancellation acknowledgement for an already-superseded draft is harmless.
    if (!this.generations.has(reviewToken)) return
    this.validate(retainedToken)
    if (retainedToken !== reviewToken) {
      this.remove(reviewToken)
      return
    }
    // An acknowledgement may arrive after a newer review started. Retire older
    // generations only; never invalidate a draft created after this token.
    for (const token of this.generations.keys()) {
      if (token === retainedToken) break
      this.remove(token)
    }
  }
}
