import { useEffect, useState } from 'react'

export type CloudConnectionState = 'checking' | 'connected' | 'disconnected' | 'subscription-required' | 'authorization-error'

export function cloudConnectionStateFromStatus(status: { status?: string; error?: string | null } | undefined): CloudConnectionState {
  if (status?.status === 'connected') return 'connected'

  const error = status?.error?.toLowerCase() ?? ''
  if (error.includes('subscription') || error.includes('http 402')) return 'subscription-required'
  if (error.includes('access denied') || error.includes('api key') || error.includes('http 401') || error.includes('http 403')) {
    return 'authorization-error'
  }

  return 'disconnected'
}

/**
 * Tracks the live Cloud Agent connection instead of assuming a saved API key
 * means the agent is online. The short poll also lets an open tool recover as
 * soon as the background agent reconnects.
 */
export function useCloudConnection(enabled: boolean): CloudConnectionState {
  const [state, setState] = useState<CloudConnectionState>(enabled ? 'checking' : 'disconnected')

  useEffect(() => {
    let cancelled = false

    if (!enabled) {
      setState('disconnected')
      return
    }

    setState('checking')

    const refresh = async () => {
      try {
        const status = await window.kudu?.cloudGetStatus?.()
        if (!cancelled) setState(cloudConnectionStateFromStatus(status))
      } catch {
        if (!cancelled) setState('disconnected')
      }
    }

    void refresh()
    const timer = window.setInterval(refresh, 5000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [enabled])

  return state
}
