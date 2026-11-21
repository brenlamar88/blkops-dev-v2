import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { GROUPS, cleanAnswers, visibleFollowUps } from '../src/lib/survey.js'

const fid='10000000-0000-0000-0000-000000000001'
const other='10000000-0000-0000-0000-000000000002'
const migration=readFileSync(new URL('../supabase/migrations/20261027000024_five_star_surveys.sql',import.meta.url),'utf8')

test('public submission validation, idempotency, and campus RLS', async () => {
 const db=new PGlite()
 try {
 await db.exec(`create role anon; create role authenticated; grant usage on schema public to anon, authenticated;
 create table facilities(id uuid primary key,name text,active boolean default true);
 insert into facilities values('${fid}','Lake Charles',true),('${other}','Monroe',true);
 create function public.my_facilities() returns setof uuid language sql as $$select '${fid}'::uuid$$;`)
 await db.exec(migration)
 await db.exec(migration) // deploy bundle is safe to rerun
 const call=async (type, overrides={}) => {
 const args={id:crypto.randomUUID(),facility:fid,type,name:'Synthetic Test',source:'Synthetic Clinic',referred:'Yes',age:40,ratings:Object.fromEntries(GROUPS[type]?.map(id=>[id,5]) || []),details:{},comments:'Synthetic only',website:'',...overrides}
 await db.query('select submit_five_star_survey($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)',[args.id,args.facility,args.type,args.name,args.source,args.referred,args.age,JSON.stringify(args.ratings),JSON.stringify(args.details),args.comments,args.website])
 return args
 }
 await db.exec('set role anon')
 assert.equal((await db.query('select * from public_five_star_facilities()')).rows.length,2)
 for (const type of Object.keys(GROUPS)) await call(type)
 const retry=await call('Referral');await call('Referral',retry)
 await assert.rejects(db.query('select * from five_star_submissions'),/permission denied/)
 await assert.rejects(call('Referral',{ratings:{28:6}}))
 await assert.rejects(call('Referral',{ratings:Object.fromEntries(GROUPS.Referral.map(id=>[id,'5']))}))
 await assert.rejects(call('Referral',{source:''}))
 await assert.rejects(call('Referral',{age:126}))
 await assert.rejects(call('Referral',{website:'spam'}))
 await assert.rejects(call('Referral',{type:'Unknown'}))
 await assert.rejects(db.query(`insert into five_star_submissions(id,facility_id,survey_type,source_facility,ratings) values(gen_random_uuid(),'${fid}','Referral','spam','{}')`),/permission denied/)
 await db.exec('reset role')
 assert.equal((await db.query('select count(*)::int as n from five_star_submissions')).rows[0].n,4)
 const cleaned=await call('Admission',{ratings:{36:1,37:5,38:5,39:5,40:5,41:5,42:5},details:{59:'Needed improvement',60:'Stale hidden answer',65:'Original high-score follow-up'}})
 const saved=(await db.query('select details from five_star_submissions where id=$1',[cleaned.id])).rows[0]
 assert.deepEqual(saved.details,{59:'Needed improvement',65:'Original high-score follow-up'})
 await call('Discharge',{facility:other})
 await db.exec('set role authenticated')
 const rows=(await db.query('select * from five_star_submissions')).rows
 assert.equal(rows.length,5);assert.ok(rows.every(r=>r.facility_id===fid))
 await assert.rejects(db.query('delete from five_star_submissions'),/permission denied/)
 await db.exec('reset role')
 await db.exec(`update five_star_public_facilities set enabled=false where facility_id='${other}';set role anon`)
 await assert.rejects(call('Discharge',{facility:other}),/unavailable/)
 } finally {await db.close()}
})

test('switching survey paths removes ratings and follow-ups from other paths',()=>{
 const cleaned=cleanAnswers('Discharge',{3:2,13:5,14:5,15:5,16:5,17:5,18:5,28:1},{43:'Discharge follow-up',45:'Referral stale'})
 assert.equal(cleaned.ratings[28],undefined)
 assert.deepEqual(cleaned.details,{43:'Discharge follow-up'})
 assert.equal(visibleFollowUps({42:5})[0].detail,'65')
 assert.equal(visibleFollowUps({42:3}).length,0)
})
