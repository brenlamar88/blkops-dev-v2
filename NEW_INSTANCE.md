# Standing up a new, independent instance

This repo is the **code** for Black Ops CRM. A running instance also needs its
own **Supabase** project (database + auth + edge functions) and its own
**Vercel** deployment. This file is the start-to-finish checklist for creating a
fresh instance that is completely separate from any other — its own database,
its own users, no shared data.

> The code copy does **not** include any operational data (companies, contacts,
> referrals, activities). You start empty and build up, or import your own.

---

## 0. Before you start

- A GitHub account with push access to this repo (the owner adds you under
  **Settings → Collaborators**).
- A [Supabase](https://supabase.com) account.
- A [Vercel](https://vercel.com) account.
- Locally: `git`, Node 18+ (`npm`), and `psql` (macOS: `brew install libpq`).

Clone the repo:
```bash
git clone <this-repo-url> blkops-crm && cd blkops-crm
npm install
```

---

## 1. Create the Supabase project

1. Supabase dashboard → **New project**. Pick an org, name it, choose a region,
   set a strong database password (save it).
2. When it finishes provisioning, note two things from **Project Settings**:
   - **Project URL** (`https://<ref>.supabase.co`) and the **anon** key
     (Settings → API) — these go in the frontend.
   - The **Session/Direct connection string** (Settings → Database →
     Connection string → URI) — this is for applying the schema.

---

## 2. Apply the database schema

The whole schema — tables, row-level security, functions, enums, and the
reference lookups (categories, denial reasons, payer sources, etc.) — lives in
`supabase/migrations/`, applied in filename order.

**With `psql` (recommended):**
```bash
export NEW_DB_URL='postgresql://postgres:YOUR-PASSWORD@db.<ref>.supabase.co:5432/postgres'
for f in supabase/migrations/2026*.sql; do
  echo "applying $f"; psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

**No `psql`?** Open each file in `supabase/migrations/` in timestamp order,
paste into the Supabase **SQL Editor**, and run. Do them in order; the first
three (`20260730*`) build the baseline and must run first.

Verify it worked:
```bash
psql "$NEW_DB_URL" -c "select count(*) from facilities;"   # expect 10
psql "$NEW_DB_URL" -c "select count(*) from companies;"    # expect 0 (empty)
```

> The baseline seeds one organization ("Freedom Behavioral Health") and ten
> campuses as a starting skeleton. Rename them to your own in the Supabase
> **table editor** (`organizations`, `facilities`), or replace them — they are
> reference rows, not operational data.

---

## 3. Deploy the edge functions

Two functions in `supabase/functions/` need deploying (`create-user` mints
logins; `reset-password` resets them). Both require the service role and verify
the caller is an admin.

```bash
npm i -g supabase
supabase link --project-ref <ref>
supabase functions deploy create-user
supabase functions deploy reset-password
```

They read `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase injects
automatically — no secrets to set for the default setup.

---

## 4. Point the app at THIS project

The frontend reads its Supabase target from environment variables. **This repo
has no production fallback baked in** (unlike the original), so the app will
refuse to start until you set them — that is intentional, so a new instance can
never accidentally talk to someone else's database.

Local development (`.env`, git-ignored):
```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon key>
```
```bash
npm run dev          # http://localhost:5173
```

---

## 5. Create the first admin

New databases have no users, and the in-app **Admin → Users** screen needs an
existing admin to add more — so the very first one is made by hand.

1. Supabase → **Authentication → Users → Add user** (set email + password,
   mark email confirmed). A `profiles` row is created automatically.
2. Grant that user admin on one campus (this also makes them an org-admin, which
   unlocks everything):
   ```sql
   insert into facility_members (user_id, facility_id, role)
   select u.id, f.id, 'admin'
   from auth.users u, facilities f
   where u.email = 'you@example.com'      -- the user from step 1
     and f.slug  = 'lakecharles';         -- any campus; change to yours
   ```
3. Log in at the app. From **Admin → Users** you can now add everyone else,
   assign campuses and roles, and from **Admin → Campuses** add your own
   facilities (which auto-seed their four territories).

---

## 6. Deploy to Vercel

1. Vercel → **Add New → Project** → import this repo.
2. Framework preset: **Vite**. Build command `npm run build`, output `dist`.
3. **Environment Variables** — add the same two as in step 4:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy. Future pushes to the default branch auto-deploy.

---

## 7. Ongoing schema changes

Same workflow as the original (see `DEPLOY.md`): every change is a new
timestamped migration in `supabase/migrations/`, proven locally with
`./scripts/verify.sh`, then applied to the live DB with `./scripts/deploy-db.sh`
(or by pasting `scripts/catch-up.sql` into the SQL editor).

---

## What is NOT carried over

- **Operational data** — companies, contacts, referrals, activities, needs
  analyses. The new instance starts empty by design.
- **Users and logins** — each instance has its own auth; create them in step 5
  and onward.
- **The original's Supabase project and Vercel deployment** — fully separate.
