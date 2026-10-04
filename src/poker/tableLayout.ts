/** Seat zero is the viewer at the bottom in either poker mode. */
export function tableSeatLayout(capacity: number, viewSeat: number) {
  const angle = Math.PI / 2 + viewSeat * 2 * Math.PI / capacity
  return {
    angle,
    x: 50 + 39 * Math.cos(angle),
    y: capacity === 9 ? [88, 82, 54, 27, 13, 13, 27, 54, 82][viewSeat] : 50 + 38 * Math.sin(angle),
    betX: 50 + 26 * Math.cos(angle),
    betY: 50 + 22 * Math.sin(angle),
  }
}

/** Reserve a clear central lane even when edge clamps move tall seats inward. */
export function pokerTableMinimumHeight(center: { left: number; right: number; height: number }, seats: { left: number; right: number; height: number; y: number }[], gap = 10): number {
  let height = 0
  for (const seat of seats) {
    if (seat.right + 6 <= center.left || seat.left - 6 >= center.right) continue
    const distance = Math.abs(seat.y - .5)
    if (distance < .01) continue // Side seats are separated by the horizontal board lane.
    const seatHeight = seat.height + 8 // Include the rotated card fan and winner outline.
    const byAnchor = (seatHeight / 2 + center.height / 2 + gap) / distance
    const byEdgeClamp = 2 * seatHeight + center.height + 2 * gap + 12
    height = Math.max(height, byAnchor, byEdgeClamp)
  }
  return Math.ceil(height)
}
