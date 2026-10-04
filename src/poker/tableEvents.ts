import type { RoomView } from '../battle/types'

/** Public table transitions shared by local training and multiplayer rooms. */
export type PokerTableEventView = Pick<RoomView, 'instanceId' | 'selfId' | 'hand' | 'settlementAt' | 'runoutPlayback'>
