import type { ReactNode } from 'react'

/** Title and one-line purpose shown above each study page. */
export function PageIntro({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return <header className="page-intro">
    <div className="page-intro-text">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
    {aside && <div className="page-intro-aside">{aside}</div>}
  </header>
}
