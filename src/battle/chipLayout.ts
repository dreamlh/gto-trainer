export interface ChipRect { x: number; y: number; width: number; height: number }
export interface ChipSeat extends ChipRect { seat: number; labelWidth?: number; labelHeight?: number }
export interface ChipAnchor { x: number; y: number; crowded: boolean }
export interface ChipLayoutInput {
  width: number; height: number; seats: readonly ChipSeat[]; center: ChipRect | null
  obstacles?: readonly ChipRect[]
  felt?: ChipRect
  labelWidth?: number; labelHeight?: number
}

const middle = (rect: ChipRect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
const expand = (rect: ChipRect, gap: number): ChipRect => ({ x: rect.x - gap, y: rect.y - gap, width: rect.width + gap * 2, height: rect.height + gap * 2 })
const overlap = (a: ChipRect, b: ChipRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/** Reserve a felt position for every occupied seat, independent of current wagers. */
export function layoutBattleChips({ width, height, seats, center, obstacles, felt, labelWidth = width <= 600 ? 26 : 36, labelHeight = width <= 600 ? 17 : 20 }: ChipLayoutInput): Map<number, ChipAnchor> {
  const anchors = new Map<number, ChipAnchor>()
  const feltBounds = felt ?? { x: width * .05, y: height * .08, width: width * .9, height: height * .84 }
  const onFelt = (rect: ChipRect) => {
    const cx = feltBounds.x + feltBounds.width / 2, cy = feltBounds.y + feltBounds.height / 2
    const rx = Math.max(1, feltBounds.width / 2 - 3), ry = Math.max(1, feltBounds.height / 2 - 3)
    return [rect.x, rect.x + rect.width].every(x => [rect.y, rect.y + rect.height].every(y => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1))
  }
  if (width <= 0 || height <= 0 || !seats.length) return anchors
  const tableCenter = { x: width / 2, y: height / 2 }
  const seatCenters = seats.map(seat => ({ seat: seat.seat, ...middle(seat) }))
  const protectedCenter = center && expand(center, 2)
  const boxes = (obstacles ?? seats).map(box => expand(box, 2))
  const candidates = seats.map(owner => {
    const ownLabelWidth = owner.labelWidth ?? labelWidth, ownLabelHeight = owner.labelHeight ?? labelHeight
    const halfWidth = ownLabelWidth / 2, halfHeight = ownLabelHeight / 2
    const origin = middle(owner)
    const direction = { x: tableCenter.x - origin.x, y: tableCenter.y - origin.y }
    const length = Math.max(1, Math.hypot(direction.x, direction.y))
    const points: { x: number; y: number; cost: number; blocked: number; rect: ChipRect }[] = []
    // A local pixel search accommodates portrait tables and asymmetric card/
    // status heights without moving a bet into the next player's sector.
    const radius = Math.max(110, Math.min(180, owner.width + ownLabelWidth))
    const firstStep = -Math.floor(radius / 4) * 4
    for (let dy = firstStep; dy <= radius; dy += 4) for (let dx = firstStep; dx <= radius; dx += 4) {
      const x = origin.x + dx, y = origin.y + dy
      if (x < halfWidth + 4 || x > width - halfWidth - 4 || y < halfHeight + 4 || y > height - halfHeight - 4) continue
      const ownDistance = Math.hypot(dx, dy)
      if (seatCenters.some(other => other.seat !== owner.seat && distance({ x, y }, other) <= ownDistance + .5)) continue
      const rect = { x: x - halfWidth, y: y - halfHeight, width: ownLabelWidth, height: ownLabelHeight }
      if (!onFelt(rect)) continue
      const boardOverlap = protectedCenter ? overlap(rect, protectedCenter) : 0
      if (boardOverlap > 0) continue
      const seatOverlap = boxes.reduce((sum, box) => sum + overlap(rect, box), 0)
      const blocked = seatOverlap
      const inward = (dx * direction.x + dy * direction.y) / length
      const tangent = Math.abs(dx * direction.y - dy * direction.x) / length
      const ownershipMargin = Math.min(...seatCenters.filter(other => other.seat !== owner.seat).map(other => distance({ x, y }, other) - ownDistance))
      const feltDistance = ((x - tableCenter.x) / (width * .42)) ** 2 + ((y - tableCenter.y) / (height * .34)) ** 2
      const cost = ownDistance + tangent * 1.5 + Math.max(0, -inward) * 3 + Math.max(0, 8 - ownershipMargin) * 20 + Math.max(0, feltDistance - .95) * 240
      points.push({ x, y, cost, blocked, rect })
    }
    points.sort((a, b) => a.blocked - b.blocked || a.cost - b.cost || a.x - b.x || a.y - b.y)
    return { seat: owner.seat, origin, points, labelWidth: ownLabelWidth, labelHeight: ownLabelHeight, free: points.filter(point => point.blocked === 0).length }
  })
  // Place the tightest sector first, then reserve the rest even if their
  // ordinary wagers are currently absent. Oversized amounts get wider slots.
  candidates.sort((a, b) => a.free - b.free || a.seat - b.seat)
  const occupied: ChipRect[] = []
  for (const candidate of candidates) {
    let best = candidate.points[0]
    let bestCost = Infinity
    for (const point of candidate.points) {
      const collisions = occupied.reduce((sum, rect) => sum + overlap(point.rect, expand(rect, 3)), 0)
      const score = (point.blocked + collisions) * 10000 + point.cost
      if (score < bestCost) { best = point; bestCost = score }
      if (point.blocked > 0 && bestCost < 10000) break
    }
    if (!best) {
      const fallback = { x: candidate.origin.x - candidate.labelWidth / 2, y: candidate.origin.y - candidate.labelHeight / 2, width: candidate.labelWidth, height: candidate.labelHeight }
      if (onFelt(fallback) && (!protectedCenter || overlap(fallback, protectedCenter) === 0)) anchors.set(candidate.seat, { ...candidate.origin, crowded: true })
      continue
    }
    const crowded = best.blocked > 0 || occupied.some(rect => overlap(best.rect, expand(rect, 3)) > 0)
    anchors.set(candidate.seat, { x: best.x, y: best.y, crowded })
    occupied.push(best.rect)
  }
  return anchors
}
