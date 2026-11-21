# Public 5 Star Survey

Target: the existing `blkops-test` application at https://freedom.blkops.com.

Public entry point: `/survey/5-star`. A campus can be preselected with
`?facility=<existing campus UUID>`. Respondents do not need accounts.
The signed-in `/surveys` page lists the selected campus's latest 200 responses,
shows each answer and follow-up, and provides the campus's shareable link.

## Database activation

Apply **only** `supabase/migrations/20261027000024_five_star_surveys.sql`
to the Supabase project actually configured in the live Vercel app. Confirm
that project first. Do not run baseline migrations on an initialized database.
The migration is also appended to `scripts/catch-up.sql` for normal deployments.

Existing active campuses matching the original survey's campus names are
enabled automatically. No campus, company, contact, or login is created or
changed. If a Jotform campus has no matching existing campus, an administrator
must resolve that campus before its surveys can be accepted. To disable a
campus survey, set its `five_star_public_facilities.enabled` to false.

The public functions expose campus IDs/names and accept validated submissions.
Anonymous users cannot read responses or access the submission table directly.
Authenticated response reads use the app's existing `my_facilities()` scope.
The RPC validates survey type, all required 1–5 integer ratings, field lengths,
patient age, campus availability, and conditional follow-ups. A hidden honeypot
rejects simple automated submissions. Repeated requests with the same random
ID do not create duplicates. This is not a CAPTCHA or a rate-limit service.

Until activation, the public route displays an unavailable message and cannot
accept submissions. Do not announce the link as ready until an actual anonymous
submission and an authenticated campus-scoped read have been verified.

## Source fidelity

Source: Jotform 242603376879165, read October 27, 2026.
Three paths: Discharge (7 ratings), Referral (8), Admission (7).
Original question IDs are retained in `ratings` and `details` for later imports.
Original follow-up conditions are preserved, including two unusual rules:
- q43 is shared by discharge q3 and referral q29.
- q65 follows q42 **greater than 4**, whereas other follow-ups use less than 4.

The form collects original respondent/facility names, prior referral status,
optional patient age, and comments. Switching paths clears hidden answers;
the database also discards inapplicable follow-up text. Existing Jotform
submissions (790 at inspection) are not imported or altered by this change.

## Verification

`npm run build` validates the frontend bundle.
`node --test tests/five-star.test.mjs` exercises the actual migration in a
throwaway PostgreSQL-compatible PGlite database: all three paths, retries,
invalid ratings, invalid types, field limits, disabled campuses, hidden-answer
cleanup, anonymous denial, and authenticated campus-scoped reads.
This local test does not activate the hosted database or prove its live flow.

## October 27 activation

The survey migration was applied to the verified live database project
`hhycqqtwhdofwbxmnbsr`. Both survey tables have RLS enabled. Ten existing
active campuses match the original survey options. Ferriday and West Monroe
are not configured in this database and require an explicit campus mapping
before they can receive surveys.

Security advisors flag the two new public SECURITY DEFINER RPCs and the
private configuration table with no policies. These are intentional: the
public RPCs expose only campus names/IDs and validated insert operations;
configuration is accessible only to the function owner. Direct response table
access remains revoked for anonymous users.

The advisor also reports pre-existing definer views, mutable function search
paths, extension placement and disabled leaked-password protection outside
this change. Review separately; this release does not alter those features.
Remediation references:
- https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view
- https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable
- https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public
- https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
