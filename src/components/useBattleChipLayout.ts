import { useLayoutEffect, type RefObject } from 'react'
import { pokerTableMinimumHeight } from '../poker/tableLayout'
import { layoutBattleChips, type ChipRect } from '../battle/chipLayout'

/** Measure only stable seat/table boxes; animation transforms never feed layout. */
export function useBattleChipLayout(tableRef: RefObject<HTMLElement>, layoutKey: string | number): void {
  useLayoutEffect(() => {
    const table = tableRef.current
    if (!table) return
    let frame = 0
    const observer = new ResizeObserver(() => schedule())
    const observed = new Set<Element>()
    const rect = (element: Element, tableBounds: DOMRect): ChipRect => {
      const bounds = element.getBoundingClientRect()
      return { x: bounds.left - tableBounds.left, y: bounds.top - tableBounds.top, width: bounds.width, height: bounds.height }
    }
    const measure = () => {
      frame = 0
      const bounds = table.getBoundingClientRect()
      if (bounds.width === 0 || bounds.height === 0) return
      const seats = [...table.querySelectorAll<HTMLElement>('.battle-seat[data-seat]')]
        .filter(seat => !seat.classList.contains('battle-seat-vacant'))
      for (const seat of table.querySelectorAll<HTMLElement>('.battle-seat[data-seat]')) {
        seat.style.setProperty('--seat-half-height', `${seat.offsetHeight / 2}px`)
        seat.style.setProperty('--seat-half-width', `${seat.offsetWidth / 2}px`)
      }
      const bets = [...table.querySelectorAll<HTMLElement>('.battle-seat-bet[data-seat]')]
      const center = table.querySelector<HTMLElement>('.battle-table-center, .battle-center')
      const felt = table.querySelector<HTMLElement>('.battle-felt')
      if (center) {
        const middle = rect(center, bounds)
        const required = pokerTableMinimumHeight({ left: middle.x, right: middle.x + middle.width, height: middle.height }, seats.map(seat => {
          const position = rect(seat, bounds)
          return { left: position.x, right: position.x + position.width, height: seat.offsetHeight, y: parseFloat(seat.style.getPropertyValue('--seat-y')) / 100 }
        }))
        const minimum = `${required}px`
        if (table.style.getPropertyValue('--poker-table-min-height') !== minimum) {
          table.style.setProperty('--poker-table-min-height', minimum)
          schedule()
          return
        }
      }
      const narrow = bounds.width <= 600
      const labelWidth = narrow ? 26 : 36, labelHeight = narrow ? 17 : 20
      const painted = seats.flatMap(seat => [...seat.querySelectorAll<HTMLElement>('.battle-seat-box, .battle-seat-status, .battle-seat-cards')])
        .filter(element => element.offsetWidth > 0 && element.offsetHeight > 0)
      const positions = layoutBattleChips({ width: bounds.width, height: bounds.height,
        seats: seats.map(seat => {
          const bet = bets.find(candidate => candidate.dataset.seat === seat.dataset.seat)
          return { seat: Number(seat.dataset.seat), ...rect(seat, bounds),
            labelWidth: Math.max(labelWidth, bet?.offsetWidth ?? 0), labelHeight: Math.max(labelHeight, bet?.offsetHeight ?? 0) }
        }),
        center: center ? rect(center, bounds) : null, felt: felt ? rect(felt, bounds) : undefined, obstacles: painted.map(element => rect(element, bounds)), labelWidth, labelHeight })
      for (const bet of bets) {
        const position = positions.get(Number(bet.dataset.seat))
        bet.style.visibility = position ? '' : 'hidden'
        if (!position) continue
        bet.style.setProperty('--bet-x', `${position.x}px`)
        bet.style.setProperty('--bet-y', `${position.y}px`)
      }
      table.dataset.chipLayoutCrowded = String(positions.size < seats.length || [...positions.values()].some(position => position.crowded))
      const targets = new Set<Element>([table, ...seats, ...painted, ...(center ? [center] : [])])
      for (const element of observed) if (!targets.has(element)) { observer.unobserve(element); observed.delete(element) }
      for (const element of targets) if (!observed.has(element)) { observed.add(element); observer.observe(element) }
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(measure) }
    const mutations = new MutationObserver(schedule)
    mutations.observe(table, { childList: true, subtree: true, characterData: true })
    measure()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect() }
  }, [tableRef, layoutKey])
}
