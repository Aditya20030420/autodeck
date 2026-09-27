import { useId } from 'react'

/**
 * AutoDeckLogo — clean "AD" monogram logomark + serif wordmark.
 *
 * Geometry (100×100 viewBox):
 *  - "A" left leg slants up to a soft rounded peak, then drops straight down as
 *    the vertical spine that is shared with the "D".
 *  - "D" is a smooth arc bowing right off that spine.
 *  - A crisp arrow rises from the A's crossbar, threads up-right through a masked
 *    gap in the letters, and ends with a 45° arrowhead inside the D's counter.
 * One diagonal blue→emerald gradient paints the whole mark. Pure inline SVG.
 *
 * @example
 * <AutoDeckLogo size={44} theme="dark" />
 * <AutoDeckLogo size={64} theme="light" showTagline={false} />
 */
export type AutoDeckLogoProps = {
  /** Logomark height in px. Default 44. */
  size?: number
  /** Show the tagline under the wordmark. Default true. */
  showTagline?: boolean
  /** Colour scheme for the wordmark + tagline. Default "dark". */
  theme?: 'dark' | 'light'
  /** Extra classes on the root element. */
  className?: string
}

export default function AutoDeckLogo({
  size = 44,
  showTagline = true,
  theme = 'dark',
  className = '',
}: AutoDeckLogoProps) {
  const uid = useId().replace(/:/g, '')
  const gradId = `ad-grad-${uid}`
  const maskId = `ad-mask-${uid}`

  const dark = theme === 'dark'
  const autoColor = dark ? '#FFFFFF' : '#0F172A'
  const deckColor = '#2DD4BF'
  const taglineColor = dark ? '#94A3B8' : '#64748B'

  const serif = "'Playfair Display', Georgia, 'Times New Roman', serif"
  const sans = "'Inter', ui-sans-serif, system-ui, sans-serif"
  const wordSize = Math.round(size * 0.66)
  const tagSize = Math.max(9, Math.round(size * 0.2))

  // Arrow path (shaft only) — reused for both the mask cut and the drawn arrow.
  const ARROW = 'M31 71 C 43 61, 53 53, 66 41'

  return (
    <span className={`group inline-flex items-center gap-3 ${className}`}>
      {/* ---------- Logomark: AD monogram ---------- */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="AutoDeck"
      >
        <defs>
          <linearGradient id={gradId} x1="14" y1="88" x2="86" y2="14" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0EA5E9" />
            <stop offset="1" stopColor="#2DD4BF" />
          </linearGradient>
          {/* Cut a clean gap in the letters wherever the arrow passes */}
          <mask id={maskId}>
            <rect x="0" y="0" width="100" height="100" fill="white" />
            <path d={ARROW} stroke="black" strokeWidth="19" strokeLinecap="round" fill="none" />
          </mask>
        </defs>

        <g
          stroke={`url(#${gradId})`}
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          {/* "A" left leg → rounded peak → vertical spine (shared with D) */}
          <g mask={`url(#${maskId})`}>
            <path d="M14 88 L44 14 L44 88" />
            {/* A crossbar */}
            <path d="M25 62 L44 62" />
            {/* "D" bowl */}
            <path d="M44 14 C 84 18, 84 84, 44 88" />
          </g>

          {/* Central arrow (threads through the masked gap) */}
          <g className="ad-arrow" style={{ transition: 'transform .3s cubic-bezier(0.32,0.72,0,1)' }}>
            <path d={ARROW} />
            {/* 45° arrowhead pointing up-right, inside the D counter */}
            <path d="M66 41 L54 42 M66 41 L65 53" />
          </g>
        </g>

        <style>{`.group:hover .ad-arrow{transform:translate(2px,-2px)}`}</style>
      </svg>

      {/* ---------- Wordmark + tagline ---------- */}
      <span className="leading-none">
        <span className="block font-bold tracking-tight" style={{ fontFamily: serif, fontSize: wordSize }}>
          <span style={{ color: autoColor }}>Auto</span>
          <span style={{ color: deckColor }}>Deck</span>
        </span>
        {showTagline && (
          <span
            className="mt-1.5 block font-medium"
            style={{ fontFamily: sans, fontSize: tagSize, color: taglineColor, letterSpacing: '0.01em' }}
          >
            Your workflow, on autopilot.
          </span>
        )}
      </span>
    </span>
  )
}

/** Small demo preview — the logo on a dark navy background, in a few sizes. */
export function AutoDeckLogoDemo() {
  return (
    <div style={{ background: '#0B192C' }} className="flex flex-col items-start gap-8 rounded-2xl p-10">
      <AutoDeckLogo size={56} theme="dark" />
      <AutoDeckLogo size={40} theme="dark" />
      <AutoDeckLogo size={32} theme="dark" showTagline={false} />
    </div>
  )
}
