import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp, useQuery } from '../lib/data'
import { Field, Text, Select, Check, Banner, Empty, Loading, Modal, Chip } from '../components/ui'
import { personName } from '../lib/format'
import { HIDEABLE_ITEMS } from '../lib/menu'

/* ------------------------------------------------------------------
   Users — assign campuses and roles, and control each person's menu.

   A user belongs to many campuses through many facility_members rows, with
   the role on each row, so this screen just adds/removes those rows. Writes
   are gated by the existing is_admin_at(facility_id) policy: a facility admin
   only ever sees and edits users on the campuses they administer.

   The roster is a dense, searchable, filterable table — one row per user —
   so it scales to hundreds of people. Per-user editing (campuses, roles, menu)
   happens in a focused modal, and resetting a password is a one-click row
   action. Every write patches the list in place, so nothing reloads.

   Creating a brand-new login needs the Supabase service key, which can't ship
   in the browser — that call goes to the create-user Edge Function.
------------------------------------------------------------------ */

const ROLES = ['rep', 'manager', 'admin']

// supabase-js throws a FunctionsHttpError on a non-2xx Edge Function response;
// its message is a generic "non-2xx status code" that hides the real reason,
// which the function puts in the response body as { error }. Dig it out.
async function fnError(e) {
  try {
    const body = await e?.context?.json?.()
    if (body?.error) return body.error
  } catch { /* body wasn't JSON — fall back to the generic message */ }
  return e?.message ?? 'Request failed.'
}

export default function Users() {
  const { memberships } = useApp()
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState(null)
  const [resetId, setResetId] = useState(null)
  const [search, setSearch] = useState('')
  const [campusFilter, setCampusFilter] = useState('')
  const [roleFilter, setRoleFilter] = useState('')

  // Campuses where the current user is an admin — the only ones they manage.
  const adminFacs = useMemo(
    () => memberships.filter((m) => m.role === 'admin').map((m) => m.facility).filter(Boolean),
    [memberships])
  const adminIds = adminFacs.map((f) => f.id)

  const membersQ = useQuery(() => adminIds.length
    ? supabase.from('facility_members')
        .select(`user_id, facility_id, role,
                 profile:profiles(id, first_name, last_name, email, active),
                 facility:facilities(id, name)`)
        .in('facility_id', adminIds)
    : null, [adminIds.join(',')])

  // Local working copies so each edit patches the list in place — no full
  // reload, no loading skeleton. useQuery's rows reference is stable until an
  // actual refetch, so this seed effect only fires on load/resync.
  const [rows, setRows] = useState([])
  useEffect(() => { setRows(membersQ.rows) }, [membersQ.rows])

  const userIds = [...new Set(rows.map((r) => r.user_id))]
  const menuQ = useQuery(() => userIds.length
    ? supabase.from('user_menu_visibility').select('user_id, menu_key')
        .eq('hidden', true).in('user_id', userIds)
    : null, [userIds.join(',')])
  const [menuRows, setMenuRows] = useState([])
  useEffect(() => { setMenuRows(menuQ.rows) }, [menuQ.rows])

  const users = useMemo(() => {
    const by = new Map()
    for (const r of rows) {
      const u = by.get(r.user_id) ?? { ...r.profile, memberships: [] }
      u.memberships.push({ facility_id: r.facility_id, name: r.facility?.name, role: r.role })
      by.set(r.user_id, u)
    }
    for (const u of by.values())
      u.memberships.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    return [...by.values()].sort((a, b) => (a.last_name ?? '').localeCompare(b.last_name ?? ''))
  }, [rows])

  const hiddenByUser = useMemo(() => {
    const m = {}
    for (const r of menuRows) (m[r.user_id] ??= new Set()).add(r.menu_key)
    return m
  }, [menuRows])

  // Run a write; on success patch local state (no refetch). On error, surface
  // it and resync from the server so the UI can never drift out of sync.
  const run = async (fn, patch) => {
    setError(null)
    try { await fn(); patch?.() }
    catch (e) { setError(e.message); membersQ.refresh(); menuQ.refresh() }
  }

  const setRole = (uid, fid, role) => run(
    () => supabase.from('facility_members').update({ role }).eq('user_id', uid).eq('facility_id', fid)
            .then(({ error }) => { if (error) throw error }),
    () => setRows((p) => p.map((r) =>
      r.user_id === uid && r.facility_id === fid ? { ...r, role } : r)))

  const addCampus = (uid, fid) => run(
    () => supabase.from('facility_members').insert({ user_id: uid, facility_id: fid, role: 'rep' })
            .then(({ error }) => { if (error) throw error }),
    () => setRows((p) => {
      const profile = p.find((r) => r.user_id === uid)?.profile
      const name = adminFacs.find((f) => f.id === fid)?.name
      return [...p, { user_id: uid, facility_id: fid, role: 'rep', profile, facility: { id: fid, name } }]
    }))

  const removeCampus = (uid, fid, name) => {
    if (!confirm(`Remove this user from ${name}?`)) return
    run(
      () => supabase.from('facility_members').delete().eq('user_id', uid).eq('facility_id', fid)
              .then(({ error }) => { if (error) throw error }),
      () => setRows((p) => p.filter((r) => !(r.user_id === uid && r.facility_id === fid))))
  }

  const toggleMenu = (uid, key, visible) => run(
    () => (visible
      ? supabase.from('user_menu_visibility').delete().eq('user_id', uid).eq('menu_key', key)
      : supabase.from('user_menu_visibility').upsert(
          { user_id: uid, menu_key: key, hidden: true }, { onConflict: 'user_id,menu_key' })
      ).then(({ error }) => { if (error) throw error }),
    () => setMenuRows((p) => visible
      ? p.filter((r) => !(r.user_id === uid && r.menu_key === key))
      : [...p, { user_id: uid, menu_key: key }]))

  // New user: patch the new membership row in from what create-user returned.
  const addUserRow = (c) => setRows((p) => [...p, {
    user_id: c.user_id, facility_id: c.facility_id, role: c.role,
    profile: { id: c.user_id, first_name: c.first_name, last_name: c.last_name, email: c.email, active: true },
    facility: { id: c.facility_id, name: adminFacs.find((f) => f.id === c.facility_id)?.name },
  }])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return users.filter((u) =>
      (!term || personName(u).toLowerCase().includes(term) || (u.email ?? '').toLowerCase().includes(term)) &&
      (!campusFilter || u.memberships.some((m) => m.facility_id === campusFilter)) &&
      (!roleFilter || u.memberships.some((m) => m.role === roleFilter)))
  }, [users, search, campusFilter, roleFilter])

  const editUser = editId && users.find((u) => u.id === editId)
  const resetUser = resetId && users.find((u) => u.id === resetId)

  if (!adminIds.length) {
    return (
      <>
        <div className="page-head"><div><h1>Users</h1></div></div>
        <Empty title="Admins only"
               body="You need the admin role at a campus to manage its users." />
      </>
    )
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>Manage people on the {adminFacs.length === 1 ? 'campus' : 'campuses'} you
             administer{adminFacs.length ? `: ${adminFacs.map((f) => f.name).join(', ')}` : ''}.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Add user</button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="toolbar">
        <input type="search" placeholder="Search name or email…" value={search}
               onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />
        {adminFacs.length > 1 && (
          <select value={campusFilter} onChange={(e) => setCampusFilter(e.target.value)} aria-label="Filter by campus">
            <option value="">All campuses</option>
            {adminFacs.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="spacer" />
        <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          {membersQ.loading ? '' : `${filtered.length}${filtered.length !== users.length ? ` of ${users.length}` : ''} user${users.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {membersQ.loading ? <Loading rows={6} /> : users.length === 0 ? (
        <Empty title="No users yet" body="Add the first user for your campus." />
      ) : filtered.length === 0 ? (
        <Empty title="No matches" body="No users match the search and filters." />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Campuses &amp; roles</th>
                  <th>Menu</th>
                  <th>Status</th>
                  <th className="num">Manage</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => {
                  const hiddenCount = hiddenByUser[u.id]?.size ?? 0
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="caps" style={{ fontWeight: 600 }}>{personName(u)}</div>
                        <div style={{ color: 'var(--ink-3)', fontSize: 12 }}>{u.email}</div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                          {u.memberships.map((m) => (
                            <span key={m.facility_id} className={'chip' + (m.role === 'admin' ? ' ok' : '')}>
                              {m.name} · {m.role}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                        {hiddenCount ? `${hiddenCount} hidden` : 'All visible'}
                      </td>
                      <td>{u.active ? <span style={{ color: 'var(--ink-3)' }}>Active</span> : <Chip kind="bad">Inactive</Chip>}</td>
                      <td className="num">
                        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm btn-primary" type="button" onClick={() => setEditId(u.id)}>Manage</button>
                          <button className="btn btn-sm" type="button" onClick={() => setResetId(u.id)}>Reset pw</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editUser && (
        <ManageUser user={editUser} adminFacs={adminFacs}
                    hidden={hiddenByUser[editUser.id] ?? new Set()}
                    onRole={setRole} onAdd={addCampus} onRemove={removeCampus} onMenu={toggleMenu}
                    onClose={() => setEditId(null)} />
      )}
      {resetUser && <ResetPassword user={resetUser} onClose={() => setResetId(null)} />}
      {adding && (
        <AddUser adminFacs={adminFacs} onClose={() => setAdding(false)}
                 onDone={(created) => { setAdding(false); addUserRow(created) }} />
      )}
    </>
  )
}

function ManageUser({ user, adminFacs, hidden, onRole, onAdd, onRemove, onMenu, onClose }) {
  const [showMenu, setShowMenu] = useState(false)
  const has = new Set(user.memberships.map((m) => m.facility_id))
  const addable = adminFacs.filter((f) => !has.has(f.id))

  return (
    <Modal title={personName(user)} onClose={onClose}>
      <div style={{ color: 'var(--ink-3)', fontSize: 12, marginTop: -6, marginBottom: 12 }}>{user.email}</div>

      <div className="section-label" style={{ marginTop: 0 }}>Campuses &amp; roles</div>
      {user.memberships.map((m) => (
        <div key={m.facility_id}
             style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span className="caps" style={{ flex: 1, fontSize: 13 }}>{m.name}</span>
          <Select value={m.role} onChange={(v) => onRole(user.id, m.facility_id, v)}
                  placeholder="" options={ROLES} />
          <button className="btn btn-sm btn-danger" type="button"
                  onClick={() => onRemove(user.id, m.facility_id, m.name)}>Remove</button>
        </div>
      ))}
      {addable.length > 0 && (
        <div style={{ maxWidth: 280, marginTop: 4 }}>
          <Select value="" placeholder="+ Add a campus…"
                  onChange={(fid) => fid && onAdd(user.id, fid)}
                  options={addable.map((f) => [f.id, f.name])} />
        </div>
      )}

      <div className="section-label">
        Menu visibility
        <button className="btn btn-sm" type="button" style={{ marginLeft: 8 }}
                onClick={() => setShowMenu((s) => !s)}>
          {showMenu ? 'Hide' : 'Edit'}
        </button>
      </div>
      {showMenu ? (
        <>
          <p style={{ color: 'var(--ink-3)', fontSize: 12, margin: '0 0 8px' }}>
            Unchecked items are hidden from this user's menu.
          </p>
          <div className="grid">
            {HIDEABLE_ITEMS.map((item) => (
              <div className="f-6" key={item.key}>
                <Check label={item.label} value={!hidden.has(item.key)}
                       onChange={(visible) => onMenu(user.id, item.key, visible)} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <p style={{ color: 'var(--ink-3)', fontSize: 12, margin: 0 }}>
          {hidden.size ? `${hidden.size} menu item${hidden.size === 1 ? '' : 's'} hidden.` : 'All menu items visible.'}
        </p>
      )}

      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}

function ResetPassword({ user, onClose }) {
  const [password, setPassword] = useState('')
  const [temporary, setTemporary] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [done, setDone] = useState(false)

  const randomize = () => {
    // A readable 12-char temp password: letters + digits, no ambiguous chars.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    let out = ''
    const r = crypto.getRandomValues(new Uint32Array(12))
    for (let i = 0; i < 12; i++) out += chars[r[i] % chars.length]
    setPassword(out)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (password.length < 8) return setErr('Use a password of at least 8 characters.')
    setBusy(true); setErr(null)
    try {
      const { data, error } = await supabase.functions.invoke('reset-password', {
        body: { user_id: user.id, password, temporary },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setDone(true)
    } catch (e2) {
      const raw = await fnError(e2)
      const msg = /Failed to send|not found|Function not found|404/i.test(raw)
        ? 'The reset-password function is not deployed yet. Deploy supabase/functions/reset-password, then try again.'
        : raw
      setErr(msg)
    }
    setBusy(false)
  }

  if (done) {
    return (
      <Modal title="Password set" onClose={onClose}>
        <p>
          {personName(user)}’s password is now <b className="mono">{password}</b>.
          {temporary
            ? ' They will be asked to choose a new one the next time they sign in.'
            : ' This is their permanent password until they change it.'}
        </p>
        <p style={{ color: 'var(--ink-3)', fontSize: 12 }}>
          Copy it now — it will not be shown again. Share it with the user over a
          secure channel.
        </p>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={`Reset password — ${personName(user)}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Banner kind="error">{err}</Banner>
        <div className="grid">
          <Field label="New password" span={12} required
                 hint="At least 8 characters.">
            <div style={{ display: 'flex', gap: 8 }}>
              <Text value={password} onChange={setPassword} type="text" autoFocus />
              <button type="button" className="btn btn-sm" onClick={randomize}>Generate</button>
            </div>
          </Field>
          <div className="f-12">
            <Check label="Temporary — require the user to change it at next sign-in"
                   value={temporary} onChange={setTemporary} />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Setting…' : 'Set password'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function AddUser({ adminFacs, onClose, onDone }) {
  const [v, setV] = useState({
    email: '', password: '', first_name: '', last_name: '',
    facility_id: adminFacs[0]?.id ?? '', role: 'rep',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const set = (k) => (val) => setV((s) => ({ ...s, [k]: val }))

  const submit = async (e) => {
    e.preventDefault()
    if (!v.email.trim() || !v.password || !v.facility_id)
      return setErr('Email, password and a campus are required.')
    if (v.password.length < 8) return setErr('Use a password of at least 8 characters.')
    setBusy(true); setErr(null)
    try {
      const { data, error } = await supabase.functions.invoke('create-user', { body: v })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      onDone({ ...v, user_id: data.user_id })
    } catch (e2) {
      // Surface the real reason (e.g. "A user with this email address has
      // already been registered"); supabase-js otherwise hides it behind a
      // generic "non-2xx status code" message. Still name the not-deployed case.
      const raw = await fnError(e2)
      const msg = /Failed to send|not found|Function not found|404/i.test(raw)
        ? 'The create-user function is not deployed yet. Deploy supabase/functions/create-user, then try again.'
        : raw
      setErr(msg); setBusy(false)
    }
  }

  return (
    <Modal title="Add user" onClose={onClose}>
      <form onSubmit={submit}>
        <Banner kind="error">{err}</Banner>
        <div className="grid">
          <Field label="First name" span={6}><Text value={v.first_name} onChange={set('first_name')} autoFocus /></Field>
          <Field label="Last name" span={6}><Text value={v.last_name} onChange={set('last_name')} /></Field>
          <Field label="Email" span={12} required><Text value={v.email} onChange={set('email')} type="email" /></Field>
          <Field label="Temporary password" span={12} required
                 hint="At least 8 characters. The user can change it after signing in.">
            <Text value={v.password} onChange={set('password')} type="text" />
          </Field>
          <Field label="Campus" span={6} required>
            <Select value={v.facility_id} onChange={set('facility_id')} placeholder=""
                    options={adminFacs.map((f) => [f.id, f.name])} />
          </Field>
          <Field label="Role" span={6}>
            <Select value={v.role} onChange={set('role')} placeholder="" options={ROLES} />
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
