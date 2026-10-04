import { useEffect, type RefObject } from 'react'

/** Reserve the same playable table and action footprint in both poker modes. */
export function usePokerTableViewport(pageRef: RefObject<HTMLElement>, active: boolean, layoutKey: string): void {
  useEffect(() => {
    const page = pageRef.current
    if (!page || !active) return
    window.scrollTo({ top: 0 })
    const measure = () => {
      const app = page.closest('.app')
      const bottomPadding = app ? parseFloat(getComputedStyle(app).paddingBottom) : 8
      const available = (window.visualViewport?.height ?? window.innerHeight) - (page.getBoundingClientRect().top + window.scrollY) - bottomPadding
      page.style.setProperty('--battle-available-height', `${Math.max(380, available)}px`)
      page.classList.toggle('battle-short-height', available < 650)
      const table = page.querySelector<HTMLElement>('.battle-table')
      const occupiedHeight = (element: Element) => {
        const style = getComputedStyle(element)
        return element.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)
      }
      const chromeHeight = [...page.children].filter(child => child.matches('.battle-room-header, .battle-error, .battle-notice, .battle-panel-bar, [data-poker-chrome]')).reduce((sum, child) => sum + occupiedHeight(child), 0)
      const column = page.querySelector('.battle-main-column')
      const extras = [...(column?.children ?? [])].filter(child => !child.classList.contains('battle-table-panel'))
      const dockHeight = extras.reduce((sum, child) => sum + occupiedHeight(child), 0)
      const columnGaps = extras.length * (column ? parseFloat(getComputedStyle(column).rowGap) || 0 : 0)
      const tablePanel = page.querySelector('.battle-table-panel')
      const tableChrome = [...(tablePanel?.children ?? [])].filter(child => child !== table).reduce((sum, child) => sum + child.getBoundingClientRect().height, 2)
      const minimum = table ? parseFloat(getComputedStyle(table).minHeight) : 300
      page.classList.toggle('battle-cramped', available < chromeHeight + dockHeight + columnGaps + tableChrome + minimum)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(page)
    const header = document.querySelector('.app-header')
    if (header) observer.observe(header)
    const panel = page.querySelector('.battle-table-panel')
    if (panel) observer.observe(panel)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure) }
  }, [active, layoutKey])
}
