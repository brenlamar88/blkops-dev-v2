export const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US',
  { month: 'short', day: '2-digit', year: 'numeric' }) : '—')

export const fmtTime = (t) => {
  if (!t) return '—'
  const [h, m] = t.split(':')
  const hh = +h % 12 || 12
  return `${hh}:${m} ${+h < 12 ? 'AM' : 'PM'}`
}

// User / rep names are shown in all caps across the app. Email (used only when
// a profile has no name) is left as-is.
export const personName = (p) => {
  if (!p) return '—'
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ')
  return name ? name.toUpperCase() : (p.email || '—')
}

// Territory names are a fixed set from the business (Red/White/Blue/Gold).
// Anything else falls through to a neutral chip rather than breaking.
export const territoryClass = (name) => {
  const k = (name || '').toLowerCase()
  return ['red', 'white', 'blue', 'gold'].includes(k) ? `t-${k}` : ''
}
