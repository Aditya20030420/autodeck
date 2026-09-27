/**
 * AutoDeckIcon — flat checklist "deck" logomark (no text).
 * Upright white checklist card over two teal cards stacked to the right, three
 * task rows (two done, one pending).
 *
 * `background` (default true) draws the rounded navy tile — use it for a favicon
 * or app icon. Pass `background={false}` to render only the deck on a
 * transparent ground so it merges into whatever is behind it (e.g. the header).
 *
 * @example
 * <AutoDeckIcon size={64} />                    // app icon / favicon (tile)
 * <AutoDeckIcon size={44} background={false} /> // header (merges with page)
 */
export default function AutoDeckIcon({
  size = 64,
  background = true,
  className = '',
}: { size?: number | string; background?: boolean; className?: string }) {
  const uid = 'adi'
  // With the tile, pad the deck in; without it, let the deck fill the box.
  const scale = background ? 0.84 : 0.98
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none"
      xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AutoDeck" className={className}>
      {background && (
        <>
          <defs>
            <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
              <stop stopColor="#234A70" />
              <stop offset="1" stopColor="#1C3A59" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="100" height="100" rx="24" fill={`url(#${uid}-bg)`} />
        </>
      )}

      <g transform={`translate(50 50) scale(${scale}) translate(-50 -50)`}>
        {/* stacked teal cards to the right */}
        <rect x="26" y="20" width="55" height="68" rx="13" fill="#0F766E" />
        <rect x="20" y="17" width="58" height="70" rx="14" fill="#14B8A6" />

        {/* main white checklist card */}
        <rect x="13" y="14" width="60" height="72" rx="15" fill="#F8FAFC" />

        {/* row 1 — done */}
        <rect x="22" y="23" width="14" height="14" rx="4" fill="#14B8A6" />
        <path d="M25.5 30.2 L29 33.5 L33 26.8" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="44" y1="30" x2="65" y2="30" stroke="#334155" strokeWidth="6" strokeLinecap="round" />

        {/* row 2 — done */}
        <rect x="22" y="43" width="14" height="14" rx="4" fill="#14B8A6" />
        <path d="M25.5 50.2 L29 53.5 L33 46.8" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="44" y1="50" x2="65" y2="50" stroke="#334155" strokeWidth="6" strokeLinecap="round" />

        {/* row 3 — pending */}
        <rect x="22" y="63" width="14" height="14" rx="4" fill="#CBD5E1" />
        <line x1="44" y1="70" x2="62" y2="70" stroke="#CBD5E1" strokeWidth="6" strokeLinecap="round" />
      </g>
    </svg>
  )
}
