import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { chatMessageParts, chatStickerForCode } from '../battle/chatStickers'
import { useLanguage } from '../battle/i18n'
import { chatStickerStyle } from './ChatSticker'

const MAX_LENGTH = 300

// The editor owns its DOM so native typing, IME and undo are not reset by React.
// Only known, non-editable sticker nodes serialize to their existing chat codes.
function readText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ')
  if (node instanceof HTMLElement) {
    const sticker = chatStickerForCode(node.dataset.chatSticker ?? '')
    if (sticker) return sticker.code
    if (node.tagName === 'BR') return node.hasAttribute('data-chat-placeholder') ? '' : '\n'
  }
  let text = ''
  for (const child of node.childNodes) {
    const block = child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName)
    if (block && text && !text.endsWith('\n')) text += '\n'
    text += readText(child)
    if (block && child.nextSibling && !text.endsWith('\n')) text += '\n'
  }
  return text
}

function editorText(editor: HTMLElement) {
  for (const placeholder of editor.querySelectorAll('[data-chat-placeholder]')) placeholder.removeAttribute('data-chat-placeholder')
  // Chromium adds a trailing BR to place the caret after a non-editable sticker.
  if (editor.lastChild instanceof HTMLBRElement && !editor.lastChild.hasAttribute('data-chat-line-break')) editor.lastChild.setAttribute('data-chat-placeholder', '')
  return readText(editor)
}

function fitText(text: string, limit: number) {
  let result = ''
  for (const part of chatMessageParts(text)) {
    for (const item of typeof part === 'string' ? [...part] : [part.code]) {
      if (result.length + item.length > limit) return result
      result += item
    }
  }
  return result
}

export type ChatComposerHandle = { focus: () => void; insert: (text: string) => boolean; selectedLength: () => number }

export const ChatComposer = forwardRef<ChatComposerHandle, {
  value: string
  onChange: (text: string) => void
  onSubmit: () => void
  onEscape: () => void
}>(function ChatComposer({ value, onChange, onSubmit, onEscape }, ref) {
  const { t, language } = useLanguage()
  const editor = useRef<HTMLDivElement>(null)
  const savedRange = useRef<Range | null>(null)
  const composing = useRef(false)

  const rememberSelection = () => {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !editor.current) return
    const range = selection.getRangeAt(0)
    if (editor.current.contains(range.startContainer) && editor.current.contains(range.endContainer)) savedRange.current = range.cloneRange()
  }
  const selectionRange = () => {
    const root = editor.current!
    const saved = savedRange.current
    if (saved && root.contains(saved.startContainer) && root.contains(saved.endContainer)) return saved.cloneRange()
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    return range
  }
  const focus = () => {
    const range = selectionRange()
    editor.current!.focus()
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const fragment = (text: string) => {
    const result = document.createDocumentFragment()
    for (const part of chatMessageParts(text)) {
      if (typeof part === 'string') part.split('\n').forEach((line, index) => {
        if (index) {
          const lineBreak = document.createElement('br')
          lineBreak.setAttribute('data-chat-line-break', '')
          result.append(lineBreak)
        }
        if (line) result.append(document.createTextNode(line))
      })
      else {
        const image = document.createElement('span')
        image.className = 'battle-chat-sticker'
        image.contentEditable = 'false'
        image.dataset.chatSticker = part.code
        image.setAttribute('role', 'img')
        image.setAttribute('aria-label', t(part.zh, part.en))
        image.title = t(part.zh, part.en)
        Object.assign(image.style, chatStickerStyle(part))
        result.append(image)
      }
    }
    return result
  }
  const replace = (text: string) => {
    const root = editor.current!
    const focused = document.activeElement === root
    root.replaceChildren(fragment(text))
    savedRange.current = null
    if (focused) focus()
  }
  const sync = () => {
    const root = editor.current!
    const raw = editorText(root)
    const next = composing.current ? raw : fitText(raw, MAX_LENGTH)
    if (next !== raw || !next && root.childNodes.length) replace(next)
    rememberSelection()
    onChange(next)
  }
  const selectedLength = () => readText(selectionRange().cloneContents()).length
  const insert = (text: string) => {
    const root = editor.current!
    if (editorText(root).length - selectedLength() + text.length > MAX_LENGTH) return false
    focus()
    const html = document.createElement('div')
    html.append(fragment(text))
    // Native insertion keeps sticker selection, deletion and undo in one history.
    // HTML is built only from escaped text nodes and our fixed sticker catalog.
    const inserted = text === '\n' ? document.execCommand('insertLineBreak') : document.execCommand('insertHTML', false, html.innerHTML)
    if (inserted) sync()
    return inserted
  }

  useImperativeHandle(ref, () => ({ focus, insert, selectedLength }))
  useEffect(() => {
    const root = editor.current!
    const beforeInput = (event: InputEvent) => {
      if (composing.current || event.isComposing || event.inputType !== 'insertText' || !event.data) return
      rememberSelection()
      if (editorText(root).length - selectedLength() + event.data.length > MAX_LENGTH) event.preventDefault()
    }
    document.addEventListener('selectionchange', rememberSelection)
    root.addEventListener('beforeinput', beforeInput)
    return () => { document.removeEventListener('selectionchange', rememberSelection); root.removeEventListener('beforeinput', beforeInput) }
  }, [])
  useLayoutEffect(() => {
    const root = editor.current!
    if (!composing.current && editorText(root) !== value) replace(value)
    for (const element of root.querySelectorAll<HTMLElement>('[data-chat-sticker]')) {
      const sticker = chatStickerForCode(element.dataset.chatSticker ?? '')
      if (sticker) { element.setAttribute('aria-label', t(sticker.zh, sticker.en)); element.title = t(sticker.zh, sticker.en) }
    }
  }, [value, language])

  return <div ref={editor} id="battle-chat-input" className="battle-chat-composer" contentEditable suppressContentEditableWarning role="textbox" aria-label={t('聊天消息', 'Chat message')} aria-multiline="true" data-placeholder={t('发送消息…', 'Message the table…')} spellCheck
    onInput={sync} onBlur={rememberSelection} onSelect={rememberSelection}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; sync() }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') onEscape()
      if (event.key === 'Enter') {
        event.preventDefault()
        if (event.shiftKey) insert('\n')
        else onSubmit()
      }
    }}
    onPaste={event => {
      event.preventDefault()
      rememberSelection()
      const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
      const remaining = MAX_LENGTH - editorText(editor.current!).length + selectedLength()
      const next = fitText(text, remaining)
      if (next) insert(next)
    }}
    onCopy={event => {
      rememberSelection()
      event.preventDefault()
      event.clipboardData.setData('text/plain', readText(selectionRange().cloneContents()))
    }}
    onCut={event => {
      rememberSelection()
      event.preventDefault()
      event.clipboardData.setData('text/plain', readText(selectionRange().cloneContents()))
      focus()
      document.execCommand('delete')
      sync()
    }}
    onDrop={event => event.preventDefault()}
  />
})
