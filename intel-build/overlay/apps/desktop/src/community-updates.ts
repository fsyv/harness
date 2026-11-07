/** Download community updates through the coordinator while retaining explicit restart approval. */
import type { DesktopUpdateCoordinator } from './update-coordinator.ts'
import type { DesktopUpdateState } from './ipc.ts'

/**
 * Adapt scheduled checks to download the checked version automatically.
 * @param updates - Process-owned coordinator; it owns transfer joining and shutdown.
 * @returns A scheduler client that never installs or restarts the application.
 */
export function communityUpdateClient(
  updates: Pick<DesktopUpdateCoordinator, 'state' | 'check' | 'download'>,
): Pick<DesktopUpdateCoordinator, 'state' | 'check'> {
  return {
    get state(): DesktopUpdateState { return updates.state },
    async check(manual = false): Promise<DesktopUpdateState> {
      const state = await updates.check(manual)
      if (state.phase !== 'available') return state
      if (state.version === undefined) throw new Error('An available community update has no version')
      return updates.download(state.version)
    },
  }
}
