import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import '../battle/actions.css'

/** Fit amounts before wrapping, including narrow screens and long translated labels. */
export function ActionLabel({ children }: { children: ReactNode }) {
  const label = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const node = label.current, button = node?.parentElement
    if (!node || !button) return
    const fit = () => {
      const style = getComputedStyle(button)
      const base = parseFloat(style.fontSize)
      const available = button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      node.style.fontSize = `${base}px`
      const width = node.getBoundingClientRect().width
      if (width > available && available > 0) node.style.fontSize = `${Math.max(8, Math.min(base, base * available / width))}px`
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(button)
    return () => observer.disconnect()
  }, [children])
  return <span className="ba-action-label" ref={label}>{children}</span>
}

export function DecisionDock({ active, label, className = '', children }: { active: boolean; label: string; className?: string; children: ReactNode }) {
  const element = useRef<HTMLElement>(null)
  const [viewport, setViewport] = useState<{ height: number; gap: number } | null>(null)
  useEffect(() => {
    if (!element.current) return
    const node = element.current
    const targets = [node.closest<HTMLElement>('.battle-main-column'), node.closest<HTMLElement>('.battle-page')]
    const measure = () => {
      const height = Math.ceil(node.getBoundingClientRect().height)
      for (const target of targets) target?.style.setProperty('--battle-action-height', `${height}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()
    return () => { observer.disconnect(); for (const target of targets) target?.style.removeProperty('--battle-action-height') }
  }, [])
  useEffect(() => {
    if (!active) return
    const visual = window.visualViewport
    const sync = () => setViewport({
      height: visual?.height ?? window.innerHeight,
      gap: visual ? Math.max(0, window.innerHeight - visual.height - visual.offsetTop) : 0,
    })
    sync()
    visual?.addEventListener('resize', sync)
    visual?.addEventListener('scroll', sync)
    window.addEventListener('resize', sync)
    return () => {
      visual?.removeEventListener('resize', sync)
      visual?.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [active])
  const style = {
    ...(viewport ? { '--ba-visible-height': `${viewport.height}px`, '--ba-keyboard-gap': `${viewport.gap}px` } : {}),
  } as CSSProperties
  return <div className={active ? 'ba-dock-slot ba-dock-slot-active' : 'ba-dock-slot'} style={style}>
    <section ref={element} className={`ba-dock ${active ? 'ba-dock-active' : ''} ${className}`} aria-label={label}>{children}</section>
  </div>
}

