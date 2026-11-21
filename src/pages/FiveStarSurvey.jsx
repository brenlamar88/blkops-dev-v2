import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp, useQuery } from '../lib/data'
import { QUESTIONS, GROUPS, visibleFollowUps, cleanAnswers } from '../lib/survey'
import './FiveStarSurvey.css'

export default function FiveStarSurvey() {
  const [facilities, setFacilities] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [type, setType] = useState('')
  const [facility, setFacility] = useState('')
  const [ratings, setRatings] = useState({})
  const [details, setDetails] = useState({})
  const requestId = useRef(crypto.randomUUID())
  const lock = useRef(false)
  useEffect(() => {
    let active = true
    supabase.rpc('public_five_star_facilities').then(({ data, error }) => {
      if (!active) return
      setLoading(false)
      if (error) return setLoadError('This survey is not available yet. Please try again later.')
      setFacilities(data || [])
      const preferred = new URLSearchParams(window.location.search).get('facility')
      if (data?.some(f => f.id === preferred)) setFacility(preferred)
    }).catch(() => { if (active) { setLoading(false); setLoadError('Unable to load the survey. Please refresh to try again.') } })
    return () => { active = false }
  }, [])
  const submit = async e => {
    e.preventDefault()
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    const form = new FormData(e.currentTarget)
    const answers = cleanAnswers(type, ratings, details)
    try {
      const { error } = await supabase.rpc('submit_five_star_survey', {
        p_id: requestId.current, p_facility_id: facility, p_survey_type: type,
        p_respondent_name: form.get('name'), p_source_facility: form.get('sourceFacility'),
        p_referred: form.get('referred') || null,
        p_patient_age: form.get('age') === '' ? null : Number(form.get('age')),
        p_ratings: answers.ratings, p_details: answers.details,
        p_comments: form.get('comments'), p_website: form.get('website'),
      })
      if (error) throw error
      setDone(true); window.scrollTo(0, 0)
    } catch { setError('Your survey could not be saved. Your answers are still here. Please try again.') }
    finally { lock.current = false; setBusy(false) }
  }
  if (done) return <main className="survey-wrap"><section className="survey-card" role="status"><p className="survey-eyebrow">FREEDOM BEHAVIORAL HEALTH</p><h1>Thank you for your feedback.</h1><p>Your survey has been received. Your feedback helps us improve our services.</p></section></main>
  return <main className="survey-wrap"><form className="survey-card" onSubmit={submit}>
    <p className="survey-eyebrow">FREEDOM BEHAVIORAL HEALTH</p><h1>5 Star Survey</h1>
    <p>Tell us how we did. Select a survey below to share your experience.</p>
    <p className="survey-note">Please do not include patient names or other identifying patient information. Fields marked * are required.</p>
    {loading ? <p role="status">Loading survey…</p> : loadError || !facilities.length ? <p role="alert">{loadError || 'This survey is not available yet. Please try again later.'}</p> : <>
      <fieldset><legend>Choose a survey *</legend><div className="survey-options">{Object.keys(GROUPS).map(t => <label key={t}><input required type="radio" name="surveyType" value={t} checked={type === t} onChange={() => { setType(t); setRatings({}); setDetails({}) }} /> {t}</label>)}</div></fieldset>
      <fieldset><legend>Have you ever referred to us?</legend><div className="survey-options">{['Yes','No'].map(v => <label key={v}><input type="radio" name="referred" value={v} /> {v}</label>)}</div></fieldset>
      {type && <>
        <label className="survey-field">Freedom Facility *<select required value={facility} onChange={e => setFacility(e.target.value)}><option value="">Please select</option>{facilities.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <p className="survey-note">Rate each statement from 1 (lowest) to 5 (highest).</p>
        {GROUPS[type].map(id => <section key={id} className="survey-question"><fieldset><legend>{QUESTIONS[id]} *</legend><div className="survey-stars">{[1,2,3,4,5].map(n => <label key={n} className={Number(ratings[id]) === n ? 'selected' : ''}><input type="radio" name={`rating-${id}`} value={n} required checked={Number(ratings[id]) === n} onChange={() => setRatings(r => ({...r, [id]:n}))} /><span aria-hidden="true">★</span><span>{n}</span><span className="sr-only"> out of 5</span></label>)}</div></fieldset>
        {visibleFollowUps(ratings).filter(r => r.rating === id).map(r => <label className="survey-field" key={r.detail}>Please provide more details for quality improvements.<textarea maxLength={2000} value={details[r.detail] || ''} onChange={e => setDetails(d => ({...d, [r.detail]: e.target.value}))} /></label>)}
        </section>)}
        <label className="survey-field">Patient Age<input name="age" type="number" min="0" max="125" step="1" /></label>
        <label className="survey-field">Any suggestions or comments<textarea name="comments" maxLength={5000} rows="4" /></label>
      </>}
      <label className="survey-field">Your Name<input name="name" maxLength={200} autoComplete="name" /></label>
      <label className="survey-field">Your Facility's Name *<input name="sourceFacility" maxLength={300} required /></label>
      <div className="survey-trap" aria-hidden="true"><label>Website<input name="website" tabIndex="-1" autoComplete="off" /></label></div>
      {error && <p role="alert" className="survey-error">{error}</p>}
      <button className="btn btn-primary" disabled={busy || !type}>{busy ? 'Submitting…' : 'Submit survey'}</button>
    </>}
  </form></main>
}

export function SurveySubmissions() {
  const { facilityId } = useApp()
  const [selected, setSelected] = useState(null)
  const detailRef = useRef(null)
  const { rows: data, error, loading } = useQuery(() => supabase.from('five_star_submissions').select('*').eq('facility_id', facilityId).order('submitted_at', { ascending:false }).limit(200), [facilityId])
  useEffect(() => setSelected(null), [facilityId])
  // When a submission is opened, scroll its detail panel into view so the
  // reviewer lands on the entry instead of hunting for it below the table.
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selected])
  const link = `${window.location.origin}/survey/5-star?facility=${facilityId}`
  return <><h1>5 Star Surveys</h1><p>Anyone with this link can complete the survey without signing in.</p><p><a href={link} target="_blank" rel="noreferrer">{link}</a></p>
    <p>Latest 200 submissions for the selected campus.</p>
    {loading && <p>Loading…</p>}{error && <p role="alert">Unable to load submissions. The survey database migration may need to be applied.</p>}
    {!loading && !error && !data?.length && <p>No surveys received yet.</p>}
    <div style={{overflowX:'auto'}}><table><thead><tr><th>Submitted</th><th>Survey</th><th>Referring facility</th><th>Name</th><th>Average</th><th /></tr></thead><tbody>{(data || []).map(s => <tr key={s.id}><td>{new Date(s.submitted_at).toLocaleString()}</td><td>{s.survey_type}</td><td>{s.source_facility}</td><td>{s.respondent_name || '—'}</td><td>{(Object.values(s.ratings).reduce((a,b)=>a+Number(b),0)/Object.keys(s.ratings).length).toFixed(1)} / 5</td><td><button className="btn" onClick={() => setSelected(s)}>View</button></td></tr>)}</tbody></table></div>
    {selected && <section ref={detailRef} key={facilityId} className="card" style={{padding:24,marginTop:24,scrollMarginTop:16}}><button className="btn" onClick={() => setSelected(null)}>Close details</button><h2>{selected.survey_type} survey</h2><p>{selected.source_facility} · {selected.respondent_name || 'Name not provided'}</p><p>Previously referred: {selected.referred || 'Not provided'} · Patient age: {selected.patient_age ?? 'Not provided'}</p>{Object.entries(selected.ratings).map(([id,value]) => <div key={id}><p><strong>{QUESTIONS[id]}</strong><br />{value} / 5</p>{visibleFollowUps(selected.ratings).filter(r=>r.rating===id).map(r=>selected.details[r.detail] && <p key={r.detail}>Follow-up: {selected.details[r.detail]}</p>)}</div>)}<h3>Suggestions or comments</h3><p style={{whiteSpace:'pre-wrap'}}>{selected.comments || 'None provided'}</p></section>}
  </>
}
