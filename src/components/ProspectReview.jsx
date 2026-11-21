import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../lib/data'
import { rpc } from '../lib/operations'
import { normalize, categoryKey, phoneProblem } from '../lib/prospect-review'
import { readProspectusFile } from '../lib/prospect-xlsx'
import { Banner, DataTable, Modal } from './ui'

export function ProspectReviewStatus({ review }) {
  if (review.loading)
    return <p role="status">Checking prospectus review availability...</p>
  if (!review.error) return null
  return (
    <section className="card card-body" role="status">
      <h2>
        {review.unavailable
          ? 'Prospectus import needs database activation'
          : 'Prospectus review could not load'}
      </h2>
      <p>
        {review.unavailable
          ? 'The connected database does not yet have the prospectus review tables. Uploads are paused until they are activated. An unavailable queue is not a clean-data result; no source-file import is confirmed here.'
          : 'Review counts are unavailable. Retry before making corrections or uploading another file.'}
      </p>
      {!review.unavailable && <Banner kind="error">{review.error}</Banner>}
      <button className="btn" onClick={() => review.refresh()}>
        Recheck prospectus availability
      </button>
    </section>
  )
}

export function ProspectImport({ program, programName, onSaved, review }) {
  const app = useApp(),
    [pack, setPack] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState('')
  async function upload() {
    setBusy(true)
    setError('')
    try {
      let added = 0
      for (let i = 0; i < pack.rows.length; i += 100) {
        added += await rpc('stage_prospectus', {
          p_facility: app.facilityId,
          p_program: program,
          p_source: pack.source_name,
          p_fingerprint: pack.fingerprint,
          p_rows: pack.rows.slice(i, i + 100),
        })
        setProgress(
          'Saved ' +
            Math.min(i + 100, pack.rows.length) +
            ' of ' +
            pack.rows.length +
            ' source rows',
        )
      }
      setProgress(
        added +
          ' new rows saved for ' +
          programName +
          '. Repeated uploads do not duplicate source rows.',
      )
      setPack(null)
      onSaved()
    } catch (e) {
      setError(e.message + ' You can retry this same file to resume safely.')
      onSaved()
    } finally {
      setBusy(false)
    }
  }
  if (!app.isAdmin || review?.loading || review?.error) return null
  return (
    <details className="card card-body prospect-import">
      <summary>
        Import prospectus for {programName || 'selected program'}
      </summary>
      <p>
        Upload the program's MASTER worksheet. Original rows are retained in
        Verification; no companies are automatically merged or overwritten.
      </p>
      <input
        aria-label="Prospectus workbook"
        type="file"
        accept=".xlsx,.json"
        disabled={busy || !program}
        onChange={async (e) => {
          const f = e.target.files[0]
          setError('')
          setPack(null)
          setProgress('')
          if (!f) return
          setBusy(true)
          try {
            setPack(await readProspectusFile(f))
          } catch (x) {
            setError(x.message)
          } finally {
            setBusy(false)
            e.target.value = ''
          }
        }}
      />
      {pack && (
        <p>
          {pack.source_name} · {pack.rows.length.toLocaleString()} MASTER
          records → <b>{programName}</b> at {app.facility?.name}.{' '}
          <button className="btn btn-primary" disabled={busy} onClick={upload}>
            Save to program review
          </button>
        </p>
      )}
      <p role="status">{progress}</p>
      <Banner kind="error">{error}</Banner>
    </details>
  )
}
export function ImportedProspects({ review, program, search = '' }) {
  if (review.loading || review.error) return null
  const rows = review.rows.filter(
    (r) =>
      r.program_id === program &&
      (!search ||
        JSON.stringify(r.record).toLowerCase().includes(search.toLowerCase())),
  )
  return (
    <section className="card card-body">
      <h2>Imported MASTER records · {rows.length.toLocaleString()}</h2>
      <p>
        Records awaiting sign-off stay here until they are linked to the shared
        company directory.{' '}
        <Link to="/verification?section=imports">
          Open Verification to resolve and approve
        </Link>
      </p>
      <Banner kind="error">{review.error}</Banner>
      <DataTable
        rows={rows}
        loading={review.loading}
        columns={[
          {
            key: 'source',
            label: 'Workbook / row',
            render: (r) => (
              <>
                {r.source_name}
                <br />
                MASTER · row {r.row_number}
              </>
            ),
          },
          ...[
            ['name', 'Prospect'],
            ['address_line1', 'Address'],
            ['city', 'City'],
            ['state', 'State'],
            ['category', 'Program category'],
            ['territory', 'Territory'],
            ['phone', 'Phone'],
          ].map(([key, label]) => ({
            key,
            label,
            render: (r) => r.record[key] || '—',
          })),
          {
            key: 'status',
            label: 'Review',
            render: (r) => (
              <Link to={'/verification?section=imports&row=' + r.id}>
                {r.status === 'linked'
                  ? 'Linked / signed'
                  : r.status === 'excluded'
                    ? 'Excluded / signed'
                    : review.analysis.get(r.id)?.issues.length ||
                        review.analysis.get(r.id)?.candidates.length
                      ? 'Needs verification'
                      : 'Awaiting review'}
              </Link>
            ),
          },
        ]}
      />
    </section>
  )
}
export function ProspectReviewQueue({ review, onChanged, initialRow }) {
  const app = useApp(),
    [program, setProgram] = useState(''),
    [history, setHistory] = useState(false),
    [selected, setSelected] = useState(null),
    [values, setValues] = useState({}),
    [action, setAction] = useState('create'),
    [target, setTarget] = useState(''),
    [evidence, setEvidence] = useState(''),
    [initials, setInitials] = useState(''),
    [attest, setAttest] = useState(false),
    [restate, setRestate] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState('')
  const pending = review.rows.filter((r) =>
    ['pending', 'submitted'].includes(r.status),
  )
  const programs = [
    ...new Map(review.rows.map((r) => [r.program_id, r.program])).entries(),
  ].sort((a, b) => (a[1]?.code || '').localeCompare(b[1]?.code || ''))
  const shown = (
    history
      ? review.rows.filter((r) => !['pending', 'submitted'].includes(r.status))
      : pending
  ).filter((r) => !program || r.program_id === program)
  const admin =
    selected &&
    app.memberships.some(
      (m) => m.facility_id === selected.facility_id && m.role === 'admin',
    )
  const campusCompanies = review.directory.filter(
    (fc) =>
      fc.facility_id === selected?.facility_id &&
      fc.company?.active &&
      !fc.company.merged_into_id,
  )
  const existingIds = new Set(campusCompanies.map((fc) => fc.company_id))
  for (const c of review.registry || [])
    if (!existingIds.has(c.id))
      campusCompanies.push({
        company_id: c.id,
        company: c,
        territory_id: null,
      })
  const company = campusCompanies.find(
    (fc) => fc.company_id === target,
  )?.company
  function edit(r) {
    setSelected(r)
    setError('')
    setValues(
      r.proposed || {
        ...r.record,
        territory_id: r.territory_id || '',
        category_id:
          app.lookups.categories?.find(
            (c) => categoryKey(c.name) === categoryKey(r.record.category),
          )?.id || '',
        tier: ['PRIMARY', 'SECONDARY', 'TERTIARY'].includes(
          normalize(r.record.prospect_status),
        )
          ? normalize(r.record.prospect_status).slice(0, 1) +
            normalize(r.record.prospect_status).slice(1).toLowerCase()
          : 'Secondary',
      },
    )
    setEvidence(r.evidence || '')
    setInitials('')
    setAttest(false)
    setRestate(false)
    setAction(r.proposed?._resolution_action || 'create')
    setTarget(r.proposed?._company_id || '')
    setSearch('')
  }
  function choose(id) {
    const fc = campusCompanies.find((c) => c.company_id === id)
    setTarget(id)
    if (fc) {
      setAction('link')
      setValues((v) => ({
        ...v,
        ...Object.fromEntries(
          ['name', 'address_line1', 'city', 'state', 'zip', 'phone', 'fax'].map(
            (k) => [k, fc.company[k] || ''],
          ),
        ),
        territory_id: fc.territory_id || v.territory_id,
        same_location: false,
        new_company_confirmed: false,
      }))
    }
  }
  const set = (k, v) => setValues((old) => ({ ...old, [k]: v }))
  async function save(next) {
    setBusy(true)
    setError('')
    try {
      if (admin)
        await rpc('resolve_prospect_row', {
          p_id: selected.id,
          p_version: selected.version,
          p_values: values,
          p_action: action,
          p_company: target || null,
          p_company_version: company?.updated_at || null,
          p_evidence: evidence,
          p_initials: initials,
          p_attest: attest,
          p_restate: restate,
        })
      else
        await rpc('propose_prospect_row', {
          p_id: selected.id,
          p_version: selected.version,
          p_values: {
            ...values,
            _resolution_action: action,
            _company_id: target,
          },
          p_evidence: evidence,
          p_initials: initials,
          p_attest: attest,
        })
      const other = shown.find((r) => r.id !== selected.id)
      review.refresh()
      onChanged?.()
      if (next && other) edit(other)
      else setSelected(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const initial = initialRow && pending.find((r) => r.id === initialRow)
  if (review.loading || review.error)
    return <ProspectReviewStatus review={review} />
  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <span className="l">Imported source rows</span>
          <span className="n">{review.rows.length.toLocaleString()}</span>
        </div>
        <div className="kpi">
          <span className="l">Awaiting review</span>
          <span className="n">{pending.length.toLocaleString()}</span>
        </div>
        <div className="kpi">
          <span className="l">
            Rows with flagged details / possible matches
          </span>
          <span className="n">
            {review.scanning
              ? 'Checking…'
              : pending
                  .filter((r) => {
                    const a = review.analysis.get(r.id)
                    return a?.issues.length || a?.candidates.length
                  })
                  .length.toLocaleString()}
          </span>
        </div>
      </div>
      <p>
        Overlapping programs may share one company. Program categories remain
        separate. Similar names, shared addresses and valid-looking phone
        numbers do not prove a match.
      </p>
      <div className="ops-tabs">
        <button
          className={'btn ' + (!program ? 'btn-primary' : '')}
          onClick={() => setProgram('')}
        >
          ALL PROGRAMS
        </button>
        {programs.map(([id, p]) => (
          <button
            className={'btn ' + (program === id ? 'btn-primary' : '')}
            key={id}
            onClick={() => setProgram(id)}
          >
            {p?.name || 'Program'}
          </button>
        ))}
      </div>
      <div className="row-actions">
        <button className="btn" onClick={() => setHistory(!history)}>
          {history ? 'Open source reviews' : 'Signed source history'}
        </button>
        <button className="btn" onClick={() => review.refresh()}>
          Refresh comparisons
        </button>
        {initial && (
          <button className="btn btn-primary" onClick={() => edit(initial)}>
            Resolve selected prospect · row {initial.row_number}
          </button>
        )}
      </div>
      <Banner kind="error">{review.error || review.scanError}</Banner>
      {review.scanning && (
        <p role="status">
          Comparing all accessible source rows and shared companies…
        </p>
      )}
      <div className="ops-verification">
        {shown.map((r) => {
          const a = review.analysis.get(r.id)
          return (
            <section className="ops-conflict card" key={r.id}>
              <div>
                <h3>Flag location</h3>
                <p>
                  {r.facility?.name}
                  <br />
                  {r.program?.name}
                  <br />
                  {r.record.territory || 'Unassigned / SDD'}
                </p>
                <small>
                  {r.source_name}
                  <br />
                  {r.sheet} · row {r.row_number}
                </small>
              </div>
              <div>
                <h3>Conflicting records</h3>
                <strong>
                  Option A · {r.record.name || 'Missing company name'}
                </strong>
                <p>
                  {r.record.address_line1}
                  <br />
                  {r.record.city}, {r.record.state} {r.record.zip}
                  <br />
                  Phone: {r.record.phone || 'Missing'}
                  <br />
                  {r.record.category}
                </p>
                {!!a?.candidates.length && (
                  <details>
                    <summary>{a.candidates.length} possible matches</summary>
                    {a.candidates.map((c) => (
                      <p key={c.kind + c.id}>
                        <b>Option B · {c.record.name}</b>
                        <br />
                        {c.record.address_line1}, {c.record.city},{' '}
                        {c.record.state}
                        <br />
                        {c.record.territory} · {c.record.category}
                        <br />
                        {c.reason}
                        <br />
                        <small>
                          {c.kind === 'company'
                            ? 'Shared company directory'
                            : c.source_name + ' · row ' + c.row_number}
                        </small>
                      </p>
                    ))}
                  </details>
                )}
              </div>
              <div>
                <h3>What is the conflict?</h3>
                {a?.issues.map((i) => (
                  <p key={i}>{i}</p>
                ))}
                {!!a?.candidates.length && (
                  <p>
                    {[...new Set(a.candidates.flatMap((c) => c.fields))].join(
                      ', ',
                    ) || 'Company/location overlap'}{' '}
                    requires comparison between Options A and B.
                  </p>
                )}
                {a && !a.issues.length && !a.candidates.length && (
                  <p>New source awaiting identity and program confirmation.</p>
                )}
                <small>
                  {r.status}
                  {r.submitter_initials
                    ? ' · Submitted by ' +
                      r.submitter_initials +
                      ' · ' +
                      r.submitted_at
                    : ''}
                </small>
              </div>
              <div>
                <h3>Resolution suggestion / editing</h3>
                <p>{a?.suggestion || 'Comparison pending.'}</p>
                <b>You must validate before submitting.</b>
                {r.research?.map((x, i) => (
                  <p key={i}>
                    <b>
                      {x.field}: {x.value}
                    </b>
                    <br />
                    {x.note}
                    <br />
                    <a
                      href={/^https:\/\//.test(x.url) ? x.url : undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Official source
                    </a>{' '}
                    · checked {x.checked_at}
                  </p>
                ))}
                {history ? (
                  <p>
                    Signed {r.initials} · {r.resolved_at}
                    <br />
                    {r.evidence}
                  </p>
                ) : (
                  <button className="btn btn-primary" onClick={() => edit(r)}>
                    Resolve conflict
                  </button>
                )}
              </div>
            </section>
          )
        })}
      </div>
      {!shown.length && !review.loading && (
        <p>
          No {history ? 'signed' : 'pending'} imported records in your
          authorized scope.
        </p>
      )}
      {selected && (
        <Modal
          title={'Verify prospect · ' + selected.record.name}
          onClose={() => setSelected(null)}
        >
          <div className="resolution-layout">
            <div>
              <p>
                {selected.source_name} · MASTER row {selected.row_number} ·{' '}
                {selected.program?.name}
              </p>
              <label className="ops-field">
                Resolution
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                >
                  <option value="create">
                    Add verified new company/location
                  </option>
                  <option value="link">
                    Link to existing company; keep its details
                  </option>
                  <option value="correct_link">
                    Link and correct shared company details
                  </option>
                  <option value="exclude">
                    Exclude this source row (retain history)
                  </option>
                </select>
              </label>
              {action !== 'exclude' && (
                <>
                  <label className="ops-field">
                    Search existing companies
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Name, address or city"
                    />
                  </label>
                  <label className="ops-field">
                    Existing company
                    <select
                      value={target}
                      onChange={(e) => choose(e.target.value)}
                    >
                      <option value="">
                        Choose an existing company to link
                      </option>
                      {campusCompanies
                        .filter(
                          (fc) =>
                            fc.company_id === target ||
                            normalize(
                              fc.company.name +
                                ' ' +
                                fc.company.address_line1 +
                                ' ' +
                                fc.company.city,
                            ).includes(normalize(search)),
                        )
                        .map((fc) => (
                          <option key={fc.company_id} value={fc.company_id}>
                            {fc.company.name} · {fc.company.address_line1} ·{' '}
                            {fc.company.city}
                          </option>
                        ))}
                    </select>
                  </label>
                  <details>
                    <summary>
                      Compare the original source and likely matches
                    </summary>
                    <pre>{JSON.stringify(selected.raw, null, 2)}</pre>
                    {review.analysis.get(selected.id)?.candidates.map((c) => (
                      <div key={c.kind + c.id} className="card card-body">
                        <b>{c.record.name}</b>
                        <p>
                          {c.record.address_line1}, {c.record.city},{' '}
                          {c.record.state}
                          <br />
                          {c.reason}
                        </p>
                        {c.kind === 'company' || c.company_id ? (
                          <button
                            className="btn"
                            onClick={() =>
                              choose(c.kind === 'company' ? c.id : c.company_id)
                            }
                          >
                            Use this existing company
                          </button>
                        ) : (
                          <button
                            className="btn"
                            onClick={() => {
                              const row = review.rows.find((r) => r.id === c.id)
                              if (row) edit(row)
                            }}
                          >
                            Review that source row first
                          </button>
                        )}
                      </div>
                    ))}
                  </details>
                  {selected.research?.map((x, i) => (
                    <p key={i}>
                      {x.field}: <b>{x.value}</b> ·{' '}
                      <a
                        href={/^https:\/\//.test(x.url) ? x.url : undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Official source
                      </a>{' '}
                      ({x.checked_at}){' '}
                      <button
                        className="btn"
                        disabled={action === 'link'}
                        onClick={() => set(x.field, x.value)}
                      >
                        Use suggestion
                      </button>
                    </p>
                  ))}
                  {review.analysis
                    .get(selected.id)
                    ?.phoneSuggestions?.map((n) => (
                      <p key={n}>
                        Other source workbook lists <b>{n}</b> for this
                        name/address/city. Not independently verified.{' '}
                        <button
                          className="btn"
                          disabled={action === 'link'}
                          onClick={() => set('phone', n)}
                        >
                          Use for review
                        </button>
                      </p>
                    ))}
                  <div className="ops-two">
                    {[
                      ['name', 'Company name'],
                      ['address_line1', 'Address'],
                      ['city', 'City'],
                      ['state', 'State'],
                      ['zip', 'ZIP'],
                      ['phone', 'Phone'],
                      ['fax', 'Fax'],
                    ].map(([key, label]) => (
                      <label className="ops-field" key={key}>
                        {label}
                        <input
                          value={values[key] || ''}
                          disabled={action === 'link'}
                          onChange={(e) => set(key, e.target.value)}
                        />
                      </label>
                    ))}
                    <label className="ops-field">
                      Program category
                      <select
                        value={values.category_id || ''}
                        onChange={(e) => set('category_id', e.target.value)}
                      >
                        <option value="">Choose category</option>
                        {(app.lookups.categories || []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="ops-field">
                      Campus territory
                      <select
                        value={values.territory_id || ''}
                        onChange={(e) => set('territory_id', e.target.value)}
                      >
                        <option value="">Choose territory</option>
                        {[
                          ...new Map(
                            review.directory
                              .filter(
                                (fc) =>
                                  fc.facility_id === selected.facility_id &&
                                  fc.territory_id,
                              )
                              .map((fc) => [
                                fc.territory_id,
                                fc.territory?.name,
                              ]),
                          ).entries(),
                          ...(selected.facility_id === app.facilityId
                            ? (app.lookups.territories || []).map((t) => [
                                t.id,
                                t.name,
                              ])
                            : []),
                        ]
                          .filter(
                            (v, i, arr) =>
                              arr.findIndex((x) => x[0] === v[0]) === i,
                          )
                          .map(([id, name]) => (
                            <option key={id} value={id}>
                              {name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="ops-field">
                      Visit cadence
                      <select
                        value={values.tier || 'Secondary'}
                        onChange={(e) => set('tier', e.target.value)}
                      >
                        {['Primary', 'Secondary', 'Tertiary'].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {phoneProblem(values.phone) && (
                    <p>
                      {phoneProblem(values.phone)}. Leave an unknown number
                      blank rather than recording a placeholder.
                    </p>
                  )}
                  <label className="ops-check">
                    <input
                      type="checkbox"
                      checked={
                        !!values[
                          action === 'create'
                            ? 'new_company_confirmed'
                            : 'same_location'
                        ]
                      }
                      onChange={(e) =>
                        set(
                          action === 'create'
                            ? 'new_company_confirmed'
                            : 'same_location',
                          e.target.checked,
                        )
                      }
                    />
                    {action === 'create'
                      ? 'I checked the matches and verified this is a new company/location.'
                      : 'I verified this is the same company AND physical location.'}
                  </label>
                </>
              )}
              <label className="ops-field">
                Evidence / verified source URL / how checked
                <textarea
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
              </label>
              {admin && (
                <label className="ops-check">
                  <input
                    type="checkbox"
                    checked={restate}
                    onChange={(e) => setRestate(e.target.checked)}
                  />
                  Also correct historical campus territory and this program's
                  referral category. Use only for data errors, not a new
                  territory assignment.
                </label>
              )}
              <label className="ops-field">
                {admin
                  ? 'Administrator initials'
                  : 'Your verification initials'}
                <input
                  value={initials}
                  maxLength={8}
                  onChange={(e) => setInitials(e.target.value)}
                />
              </label>
              <label className="ops-check">
                <input
                  type="checkbox"
                  checked={attest}
                  onChange={(e) => setAttest(e.target.checked)}
                />
                {admin
                  ? 'I verified and approve this resolution.'
                  : 'I checked the details and submit them for administrator approval.'}
              </label>
              <Banner kind="error">{error}</Banner>
              <div className="row-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => save(false)}
                >
                  {admin
                    ? 'Apply signed resolution'
                    : 'Submit to administrator'}
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => save(true)}
                >
                  Save & next
                </button>
              </div>
            </div>
            <aside className="resolution-recommendation">
              <h3>Recommended review</h3>
              <p>{review.analysis.get(selected.id)?.suggestion}</p>
              <p>
                <b>Validate every suggested value before submitting.</b> A
                shared company can belong to both programs with different
                categories.
              </p>
              {review.analysis
                .get(selected.id)
                ?.candidates.slice(0, 1)
                .map((c) => (
                  <div key={c.id}>
                    <b>Option B · closest suggested match</b>
                    <p>
                      {c.record.name}
                      <br />
                      {c.record.address_line1}
                      <br />
                      {c.record.city}, {c.record.state}
                    </p>
                    <p>{c.reason}</p>
                  </div>
                ))}
              <p>
                Your initials record your review. The administrator separately
                verifies and signs the final correction.
              </p>
            </aside>
          </div>
        </Modal>
      )}
    </>
  )
}
