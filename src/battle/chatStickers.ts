export const CHAT_STICKERS = [
  { code: ':nice-hand:', zh: '好牌', en: 'Nice hand', cell: 0 },
  { code: ':bad-beat:', zh: '爆冷', en: 'Bad beat', cell: 1 },
  { code: ':bluff:', zh: '诈唬', en: 'Bluff', cell: 2 },
  { code: ':all-in:', zh: '全下', en: 'All in', cell: 3 },
  { code: ':thinking:', zh: '思考中', en: 'Thinking', cell: 4 },
  { code: ':good-luck:', zh: '好运', en: 'Good luck', cell: 5 },
  { code: ':tilt:', zh: '上头了', en: 'On tilt', cell: 6 },
  { code: ':gg:', zh: '打得好', en: 'Good game', cell: 7 },
  { code: ':lol:', zh: '笑哭了', en: 'LOL', cell: 8 },
  { code: ':check:', zh: '过牌', en: 'Check', cell: 9 },
  { code: ':call:', zh: '跟了', en: 'Call', cell: 10 },
  { code: ':raise:', zh: '加注', en: 'Raise', cell: 11 },
  { code: ':fold:', zh: '弃了', en: 'Fold', cell: 12 },
  { code: ':ship-it:', zh: '拿下', en: 'Ship it', cell: 13 },
  { code: ':so-close:', zh: '差一点', en: 'So close', cell: 14 },
  { code: ':help:', zh: '救命', en: 'Help', cell: 15 },
  { code: ':stay-cool:', zh: '冷静', en: 'Stay cool', cell: 16 },
  { code: ':on-fire:', zh: '火热', en: 'On fire', cell: 17 },
  { code: ':shark:', zh: '鲨鱼', en: 'Shark', cell: 18 },
  { code: ':fish:', zh: '小鱼', en: 'Fish', cell: 19 },
  { code: ':deal-me-in:', zh: '发牌吧', en: 'Deal me in', cell: 20 },
  { code: ':got-it:', zh: '收到', en: 'Got it', cell: 21 },
  { code: ':thanks:', zh: '谢谢', en: 'Thanks', cell: 22 },
  { code: ':sorry:', zh: '抱歉', en: 'Sorry', cell: 23 },
  { code: ':one-moment:', zh: '稍等', en: 'One moment', cell: 24 },
  { code: ':watching:', zh: '围观', en: 'Watching', cell: 25 },
  { code: ':bye:', zh: '再见', en: 'Bye', cell: 26 },
] as const

export type ChatSticker = typeof CHAT_STICKERS[number]
const STICKERS_BY_CODE = new Map<string, ChatSticker>(CHAT_STICKERS.map(sticker => [sticker.code, sticker]))

// Only our fixed shortcodes become images; all other user content stays plain text.
export function chatMessageParts(text: string): (string | ChatSticker)[] {
  return text.split(/(:[a-z-]+:)/g).filter(Boolean).map(part => STICKERS_BY_CODE.get(part) ?? part)
}
