import assert from 'node:assert/strict'
import { layoutBattleChips, type ChipRect, type ChipSeat } from '../src/battle/chipLayout'

function fixture(width: number, height: number, count = 9, seatWidth = 72, seatHeight = 73) {
  const seats: ChipSeat[] = Array.from({ length: count }, (_, seat) => {
    const angle = Math.PI / 2 + seat * 2 * Math.PI / count
    const x = width * (.5 + .39 * Math.cos(angle)), y = Math.max(50, Math.min(height - 50, height * (.5 + .38 * Math.sin(angle))))
    return { seat: seat + 1, x: x - seatWidth / 2, y: y - seatHeight / 2, width: seatWidth, height: seatHeight }
  })
  return { width, height, seats, center: { x: width / 2 - 75, y: height / 2 - 39, width: 150, height: 78 } }
}
const intersection = (a: ChipRect, b: ChipRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

for (const input of [fixture(490, 332), fixture(375, 420), fixture(900, 420, 9, 112, 85), fixture(490, 302, 6)]) {
  const positions = layoutBattleChips(input)
  assert.equal(positions.size, input.seats.length)
  const boxes: ChipRect[] = []
  for (const [seat, position] of positions) {
    const owner = input.seats.find(candidate => candidate.seat === seat)!
    const ownDistance = Math.hypot(position.x - owner.x - owner.width / 2, position.y - owner.y - owner.height / 2)
    for (const other of input.seats.filter(candidate => candidate.seat !== seat)) {
      assert(ownDistance < Math.hypot(position.x - other.x - other.width / 2, position.y - other.y - other.height / 2), `Seat ${seat}'s chip stays nearest to its owner at ${input.width}×${input.height}`)
    }
    const labelWidth = input.width <= 600 ? 26 : 36, labelHeight = input.width <= 600 ? 17 : 20
    const box = { x: position.x - labelWidth / 2, y: position.y - labelHeight / 2, width: labelWidth, height: labelHeight }
    for (const x of [box.x, box.x + box.width]) for (const y of [box.y, box.y + box.height]) {
      assert(((x - input.width / 2) / (input.width * .45 - 3)) ** 2 + ((y - input.height / 2) / (input.height * .42 - 3)) ** 2 <= 1, 'The entire chip label stays inside the felt boundary')
    }
    if (!position.crowded) {
      assert.equal(intersection(box, input.center), 0)
      input.seats.forEach(other => assert.equal(intersection(box, other), 0))
      boxes.forEach(other => assert.equal(intersection(box, other), 0))
    }
    boxes.push(box)
  }
  assert.deepEqual(layoutBattleChips({ ...input, seats: [...input.seats].reverse() }), positions, 'Seat iteration order cannot shift reserved chip anchors')
  assert([...positions.values()].every(position => !position.crowded), `${input.width}×${input.height} provides room for all reserved wagers`)
}
const cramped = fixture(350, 230)
assert([...layoutBattleChips(cramped).values()].some(position => position.crowded), 'A genuinely impossible layout reports congestion instead of claiming a collision-free fit')
const phone = fixture(368, 300, 9, 72, 80.5)
phone.seats[0].height = 90.5
phone.seats[0].y -= 5
const painted = phone.seats.flatMap((seat, index) => {
  const cardsHeight = index === 0 ? 41 : 29
  const cardsWidth = index === 0 ? 62 : 39
  return [
    { x: seat.x + (seat.width - cardsWidth) / 2, y: seat.y, width: cardsWidth, height: cardsHeight },
    { x: seat.x, y: seat.y + cardsHeight + 3, width: seat.width, height: 33.5 },
    { x: seat.x + 4, y: seat.y + seat.height - 14, width: seat.width - 8, height: 14 },
  ]
})
const phoneInput = { ...phone, center: { x: 108.5, y: 116.75, width: 151, height: 66.5 }, obstacles: painted }
const phoneLayout = layoutBattleChips(phoneInput)
for (const [seat, position] of phoneLayout) {
  const owner = phone.seats.find(candidate => candidate.seat === seat)!
  const ownDistance = Math.hypot(position.x - owner.x - owner.width / 2, position.y - owner.y - owner.height / 2)
  assert(phone.seats.every(other => other.seat === seat || ownDistance < Math.hypot(position.x - other.x - other.width / 2, position.y - other.y - other.height / 2)))
  const chip = { x: position.x - 13, y: position.y - 8.5, width: 26, height: 17 }
  assert.equal(intersection(chip, phoneInput.center), 0, 'The actual 390-pixel phone board stays clear')
  if (!position.crowded) painted.forEach(obstacle => assert.equal(intersection(chip, obstacle), 0))
}
assert([...phoneLayout.values()].every(position => !position.crowded), `Transparent card-row corners allow nine nearby felt wagers on the actual 368×300 table: ${JSON.stringify([...phoneLayout])}`)
assert.deepEqual(layoutBattleChips(phoneInput), phoneLayout, 'Repeated measurements preserve all nine anchors')
for (const oversizedSeats of [new Set([3]), new Set(phone.seats.map(seat => seat.seat))]) {
  const input = { ...phoneInput, seats: phone.seats.map(seat => ({ ...seat, labelWidth: oversizedSeats.has(seat.seat) ? 42 : 26 })) }
  const positions = layoutBattleChips(input)
  for (const [seat, position] of positions) {
    const width = oversizedSeats.has(seat) ? 42 : 26
    assert.equal(intersection({ x: position.x - width / 2, y: position.y - 8.5, width, height: 17 }, input.center), 0, 'Even oversized amounts cannot cover the public board')
    const owner = input.seats.find(candidate => candidate.seat === seat)!
    const ownDistance = Math.hypot(position.x - owner.x - owner.width / 2, position.y - owner.y - owner.height / 2)
    assert(input.seats.every(other => other.seat === seat || ownDistance < Math.hypot(position.x - other.x - other.width / 2, position.y - other.y - other.height / 2)))
  }
}
assert.equal(layoutBattleChips({ width: 0, height: 0, seats: [], center: null }).size, 0)
console.log('Battle chip layout: 9-seat desktop/portrait/cramped layouts, board and seat clearance, nearest-owner assignment, deterministic anchors and explicit congestion passed.')
