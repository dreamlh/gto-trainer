import { CHAT_EMOJI_GROUPS } from '../battle/emojiCatalog'
import { useLanguage } from '../battle/i18n'
import { CHAT_STICKERS } from '../battle/chatStickers'
import { ChatSticker } from './ChatSticker'

const PAGE_SIZE = 35
const STICKER_PAGE_SIZE = 9
const ALL_EMOJI = CHAT_EMOJI_GROUPS.flatMap(group => group.emojis)
const GROUP_NAMES: Record<string, string> = {
  'Smileys & Emotion': '笑脸与情感',
  'People & Body': '人物与手势',
  Component: '肤色与发型',
  'Animals & Nature': '动物与自然',
  'Food & Drink': '食物与饮品',
  'Travel & Places': '旅行与地点',
  Activities: '活动与运动',
  Objects: '物品',
  Symbols: '符号',
  Flags: '旗帜',
}

export type ChatEmojiPickerState = { tab: 'stickers' | 'emoji'; category: string; page: number; stickerPage: number }

export default function ChatEmojiPicker({ onSelect, remaining, selection, onSelectionChange }: {
  onSelect: (emoji: string) => void
  remaining: number
  selection: ChatEmojiPickerState
  onSelectionChange: (selection: ChatEmojiPickerState) => void
}) {
  const { t } = useLanguage()
  const { tab, category, page, stickerPage } = selection
  const isSticker = tab === 'stickers'
  const emojis = category === 'all' ? ALL_EMOJI : CHAT_EMOJI_GROUPS.find(group => group.name === category)!.emojis
  const pageCount = Math.ceil(isSticker ? CHAT_STICKERS.length / STICKER_PAGE_SIZE : emojis.length / PAGE_SIZE)
  const currentPage = isSticker ? stickerPage : page
  const changePage = (value: number) => onSelectionChange({ ...selection, [isSticker ? 'stickerPage' : 'page']: value })
  return <>
    <div className="battle-emoji-tabs" role="group" aria-label={t('表情类型', 'Emoji type')}>
      <button type="button" aria-pressed={isSticker} onClick={() => onSelectionChange({ ...selection, tab: 'stickers' })}>{t('牌桌表情', 'Stickers')} · {CHAT_STICKERS.length}</button>
      <button type="button" aria-pressed={!isSticker} onClick={() => onSelectionChange({ ...selection, tab: 'emoji' })}>Emoji · {ALL_EMOJI.length}</button>
    </div>
    {isSticker ? <div className="battle-sticker-grid" key={`stickers:${stickerPage}`}>
      {CHAT_STICKERS.slice(stickerPage * STICKER_PAGE_SIZE, (stickerPage + 1) * STICKER_PAGE_SIZE).map(sticker => <button key={sticker.code} type="button" aria-label={t(sticker.zh, sticker.en)} disabled={sticker.code.length > remaining} onMouseDown={event => event.preventDefault()} onClick={() => onSelect(sticker.code)}><ChatSticker sticker={sticker} /><span>{t(sticker.zh, sticker.en)}</span></button>)}
    </div> : <>
      <select className="battle-emoji-category" aria-label={t('表情分类', 'Emoji category')} value={category} onChange={event => onSelectionChange({ ...selection, category: event.target.value, page: 0 })}>
        <option value="all">{t('全部表情', 'All emoji')} · {ALL_EMOJI.length}</option>
        {CHAT_EMOJI_GROUPS.map(group => <option value={group.name} key={group.name}>{t(GROUP_NAMES[group.name], group.name)} · {group.emojis.length}</option>)}
      </select>
      <div className="battle-emoji-grid" key={`emoji:${category}:${page}`}>
        {emojis.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(([emoji, name]) => <button key={emoji} type="button" title={name} aria-label={`${emoji} ${name}`} disabled={emoji.length > remaining} onMouseDown={event => event.preventDefault()} onClick={() => onSelect(emoji)}>{emoji}</button>)}
      </div>
    </>}
    <nav className="battle-emoji-pagination" aria-label={t('表情分页', 'Emoji pages')}>
      <button type="button" aria-label={t('上一页表情', 'Previous emoji page')} disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>‹</button>
      <select aria-label={t('表情页码', 'Emoji page')} value={currentPage} onChange={event => changePage(Number(event.target.value))}>
        {Array.from({ length: pageCount }, (_, index) => <option value={index} key={index}>{t(`第 ${index + 1} / ${pageCount} 页`, `${index + 1} / ${pageCount}`)}</option>)}
      </select>
      <button type="button" aria-label={t('下一页表情', 'Next emoji page')} disabled={currentPage === pageCount - 1} onClick={() => changePage(currentPage + 1)}>›</button>
    </nav>
  </>
}
