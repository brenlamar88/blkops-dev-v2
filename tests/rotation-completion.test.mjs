import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stopCompleted, buildFiveWeeks, tierOf } from '../src/lib/operations-core.js'

// A rotation stop is "completed" when the route's rep logged a Quality Touch
// or Face to Face at that company on that day. Program match and in_person /
// visit_outcome are intentionally NOT required — production activity entry
// does not capture them.

const REP = 'rep-1', OTHER = 'rep-2'
const CO = 'co-1'
const DAY = { date: '2026-11-10' }
const STOP = { company_id: CO }
const PROG = 'prog-B'

// Default activity row mirrors production's shape: no program_id, no in_person.
const act = (o = {}) => ({
  user_id: REP, company_id: CO, activity_date: DAY.date,
  activity_type: 'Quality Touch', program_id: null, in_person: null,
  visit_outcome: 'completed', ...o,
})
const done = (activities) => stopCompleted(DAY, STOP, activities, REP, PROG)

test('Quality Touch and Face to Face complete the stop', () => {
  assert.equal(done([act({ activity_type: 'Quality Touch' })]), true)
  assert.equal(done([act({ activity_type: 'Face to Face' })]), true)
})

test('other activity types do not complete the stop', () => {
  for (const t of ['Cold Call', 'Follow-Up', 'Leave Behind', 'Pre Screen', "Thank You's", 'HWD Survey', 'In-Service']) {
    assert.equal(done([act({ activity_type: t })]), false, `${t} should not complete`)
  }
})

test('must match the rep, company and day', () => {
  assert.equal(done([act({ user_id: OTHER })]), false, 'different rep')
  assert.equal(done([act({ company_id: 'co-2' })]), false, 'different company')
  assert.equal(done([act({ activity_date: '2026-11-09' })]), false, 'different day')
})

test('program is not required (null or different still completes)', () => {
  assert.equal(done([act({ program_id: null })]), true)
  assert.equal(done([act({ program_id: 'prog-A' })]), true)
})

test('completes with production shape (in_person null, visit_outcome unset)', () => {
  assert.equal(done([act({ in_person: null, visit_outcome: null })]), true)
})

test('one qualifying activity among non-qualifying ones completes', () => {
  assert.equal(done([act({ activity_type: 'Cold Call' }), act({ activity_type: 'Face to Face' })]), true)
})

test('no activities does not complete', () => {
  assert.equal(done([]), false)
})

// ---- daily rotation prioritizes Primary accounts, then Secondary ----

const CITY = 'TESTCITY'
// A pool company in one city; Hospitals => Primary via tierOf, others Secondary.
const co = (i, category) => ({
  id: `c-${category}-${i}`, name: `${category} ${String(i).padStart(2, '0')}`,
  city: CITY, address_line1: `${i} Main St`, category,
  active: true, status: 'open', distance_miles: 10,
})
// Every day of both weeks draws from the same single city.
const oneCity = [0, 1].map(() => [0, 1, 2, 3, 4].map(() => [CITY]))
const build = (pool) => buildFiveWeeks({
  start: '2026-11-09', pool, history: new Map(), windows: [],
  program: 'P', address: '', corridors: oneCity,
})

test('tierOf: hospitals are Primary, community defaults to Secondary', () => {
  assert.equal(tierOf(co(1, 'hospital')), 'Primary')
  assert.equal(tierOf(co(1, 'community')), 'Secondary')
})

test('a day fills entirely with Primary when enough Primary are eligible', () => {
  // 15 Primary + 15 Secondary, Monday goal is 12 — all 12 stops should be Primary.
  const pool = [...Array(15)].map((_, i) => co(i, 'hospital'))
    .concat([...Array(15)].map((_, i) => co(i, 'community')))
  const day0 = build(pool).days[0]
  assert.equal(day0.goal, 12)
  assert.ok(day0.stops.every((s) => s.tier === 'Primary'),
    'every scheduled stop should be Primary')
})

test('Secondary is scheduled only after Primary is exhausted', () => {
  // 8 Primary + 10 Secondary, goal 12 — all 8 Primary chosen, remainder Secondary.
  const pool = [...Array(8)].map((_, i) => co(i, 'hospital'))
    .concat([...Array(10)].map((_, i) => co(i, 'community')))
  const day0 = build(pool).days[0]
  const primary = day0.stops.filter((s) => s.tier === 'Primary').length
  const secondary = day0.stops.filter((s) => s.tier === 'Secondary').length
  assert.equal(primary, 8, 'all Primary accounts are scheduled first')
  assert.equal(secondary, day0.stops.length - 8, 'Secondary fills the remainder')
})
