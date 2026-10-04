import { useEffect, useReducer, useRef } from 'react'
import { BattlePreActionController, currentPreAction, preActionAvailability, type BattlePreAction } from '../battle/preAction'
import type { RoomCommand, RoomView } from '../battle/types'

/** Preselect while waiting, then submit once against the freshest rendered turn. */
export function useBattlePreAction(room: RoomView, busy: boolean, onCommand: (command: RoomCommand) => Promise<void>) {
  const controller = useRef(new BattlePreActionController())
  const latest = useRef({ room, busy, onCommand })
  latest.current = { room, busy, onCommand }
  const [, refresh] = useReducer((value: number) => value + 1, 0)

  useEffect(() => {
    const current = latest.current
    const previous = controller.current.selection
    const command = controller.current.take(current.room, current.busy)
    if (controller.current.selection !== previous) refresh()
    if (!command) return
    // The parent presents command errors. Never retain or retry a failed pre-action.
    try { void Promise.resolve(current.onCommand(command)).catch(() => {}) } catch { /* Also contain synchronous command failures. */ }
  })

  const toggle = (action: BattlePreAction) => {
    const current = latest.current
    const previous = controller.current.selection
    controller.current.toggle(current.room, action)
    if (controller.current.selection !== previous) refresh()
  }
  const available = preActionAvailability(room)
  return {
    selected: currentPreAction(controller.current.selection, room)?.action ?? null,
    canSelect: available.canSelect,
    actions: (['fold', 'check'] as const).filter(action => action === 'check' ? available.canCheck : available.canFold),
    toggle,
  }
}
