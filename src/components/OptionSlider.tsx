import { useId, type CSSProperties } from 'react'

interface OptionSliderProps<T extends number> {
  label: string
  /** The allowed values, in slider order. Values need not be evenly spaced. */
  values: readonly T[]
  value: T
  onChange: (value: T) => void
  /** Full text for the current value, shown beside the label and read by screen readers. */
  format: (value: T) => string
  /** Short text under the track; values without a label still get a tick. */
  tickLabel?: (value: T) => string | null
  disabled?: boolean
}

/** A discrete slider: one stop per allowed value, a live readout and labelled ticks. */
export function OptionSlider<T extends number>({ label, values, value, onChange, format, tickLabel, disabled }: OptionSliderProps<T>) {
  const id = useId()
  const index = Math.max(0, values.indexOf(value))
  const last = Math.max(1, values.length - 1)
  const position = (i: number) => ({ '--p': i / last } as CSSProperties)
  return <div className={`option-slider${disabled ? ' is-disabled' : ''}`}>
    <div className="option-slider-head">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{format(values[index])}</output>
    </div>
    <input id={id} type="range" min={0} max={last} step={1} value={index} disabled={disabled}
      style={position(index)} aria-valuetext={format(values[index])}
      onChange={event => onChange(values[Number(event.target.value)])} />
    <div className="option-slider-ticks" aria-hidden="true">
      {values.map((option, i) => {
        const text = tickLabel ? tickLabel(option) : String(option)
        // Long ranges keep only their labelled ticks, so the scale stays legible.
        if (!text && values.length > 20) return null
        return <span key={option} style={position(i)}
          className={`${i === index ? 'is-active' : ''}${i < index ? ' is-passed' : ''}${text ? ' has-label' : ''}${i === 0 ? ' is-first' : ''}${i === last ? ' is-last' : ''}`}
          onClick={() => { if (!disabled) onChange(option) }}>{text}</span>
      })}
    </div>
  </div>
}
