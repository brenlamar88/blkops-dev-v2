import { Link } from 'react-router-dom'
import badge from '../assets/black-ops-badge.png'
import { Banner, Loading } from './ui'
export function OpsState({ query, children }) {
  if (query.loading && !query.data) return <Loading />
  if (query.error)
    return (
      <Banner kind="error">
        <strong>Unable to load this workspace.</strong>
        <p>
          {/schema cache|does not exist|could not find.*(table|column)/i.test(
            query.error,
          )
            ? 'The app is updated, but its connected database still needs the marketing operations update. Your administrator can apply the migration files from this repository to the existing database.'
            : 'Please try again. If the problem continues, share the details below with your administrator.'}
        </p>
        <details>
          <summary>Details</summary>
          {query.error}
        </details>
        <button className="btn" onClick={query.refresh}>
          Try again
        </button>
      </Banner>
    )
  if (!query.data) return null
  return children
}
export function OpsHead({ title, children }) {
  return (
    <div className="page-head">
      <div>
        <div className="ops-eyebrow">BLACK OPS</div>
        <div className="ops-title">
          <h1>{title}</h1>
          <img src={badge} alt="" width="36" height="28" />
        </div>
      </div>
      <div className="row-actions">{children}</div>
    </div>
  )
}
export function ProgramPick({ data, value, onChange, all = false }) {
  return (
    <label className="ops-field">
      Workbook / program
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all ? 'All programs' : 'Choose program'}</option>
        {(data?.programs || [])
          .filter((p) => p.active)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
    </label>
  )
}
export function OpsTabs({ items }) {
  return (
    <div className="ops-tabs">
      {items.map(([to, name]) => (
        <Link className="btn" to={to} key={to}>
          {name.toUpperCase()}
        </Link>
      ))}
    </div>
  )
}
export function ComingSoon({ title }) {
  return (
    <>
      <OpsHead title={title} />
      <div className="card card-body">
        <h2>
          {title === 'Battle Plan' ? "Pending Jason's outline" : 'Coming soon'}
        </h2>
        {title === 'Battle Plan' && (
          <p>
            Bryce and Brennan will build this section from Jason's approved
            outline.
          </p>
        )}
      </div>
    </>
  )
}
export function PersonPick({ data, value, onChange, label = 'Marketer' }) {
  return (
    <label className="ops-field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Campus / choose marketer</option>
        {(data?.members || []).map((m) => (
          <option key={m.user_id} value={m.user_id}>
            {[m.profile?.first_name, m.profile?.last_name]
              .filter(Boolean)
              .join(' ') || m.profile?.email}
          </option>
        ))}
      </select>
    </label>
  )
}
