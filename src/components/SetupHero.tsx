import { makeCard } from '../poker/cards'
import { CardFace } from './CardFace'

/** Decorative table edge for the setup screens: cloth under a lamp, two hole cards and a short chip stack. */
export function SetupHero({ cards }: { cards: [[number, number], [number, number]] }) {
  return <div className="setup-hero" aria-hidden="true">
    <div className="setup-hero-felt" />
    <div className="setup-hero-cards">
      {cards.map(([rank, suit], i) => <span key={i} className={`setup-hero-card setup-hero-card-${i}`}><CardFace card={makeCard(rank, suit)} size="lg" /></span>)}
    </div>
    <div className="setup-hero-chips"><i /><i /><i /><i /></div>
  </div>
}
