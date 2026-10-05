import stickerAtlas1 from '../assets/poker-stickers-v1.webp'
import stickerAtlas2 from '../assets/poker-stickers-v2.webp'
import stickerAtlas3 from '../assets/poker-stickers-v3.webp'
import { chatMessageParts, type ChatSticker as Sticker } from '../battle/chatStickers'
import { useLanguage } from '../battle/i18n'

const STICKER_ATLASES = [stickerAtlas1, stickerAtlas2, stickerAtlas3]

export function chatStickerStyle(sticker: Sticker) {
  const cell = sticker.cell % 9
  return { backgroundImage: `url(${STICKER_ATLASES[Math.floor(sticker.cell / 9)]})`, backgroundPosition: `${cell % 3 * 50}% ${Math.floor(cell / 3) * 50}%` }
}

export function ChatSticker({ sticker }: { sticker: Sticker }) {
  const { t } = useLanguage()
  const label = t(sticker.zh, sticker.en)
  return <span className="battle-chat-sticker" role="img" aria-label={label} title={label} style={chatStickerStyle(sticker)} />
}

export function ChatMessageContent({ text }: { text: string }) {
  const parts = chatMessageParts(text)
  const stickersOnly = parts.some(part => typeof part !== 'string') && parts.every(part => typeof part !== 'string' || !part.trim())
  return <span className={stickersOnly ? 'battle-chat-stickers-only' : undefined}>{parts.map((part, index) => typeof part === 'string' ? part : <ChatSticker key={index} sticker={part} />)}</span>
}
