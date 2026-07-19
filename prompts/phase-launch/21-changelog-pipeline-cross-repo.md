The changelog writes itself, and it spans two repos: the **Workspace**
app is where versions ship; `mogginglabs.com` is where the world reads
them. Build the release-driven pipeline so a tagged release auto-produces a
changelog that lands on the site's new `/changelog` — no one hand-writes
it. There is no `/changelog` today; this is net-new.

## Steps
1. **The source + convention (Workspace repo)**: adopt Conventional
   Commits + a PR-label set; a deterministic generator
   (`scripts/gen-changelog.mjs`) turns a tag range into a structured
   `changelog.json` in the house release format (`docs/RELEASING.md`: bold
   thesis · Highlights · grouped changes) AND appends `CHANGELOG.md`. Same
   range → same output.
2. **Wire into `release.yml` (Workspace)**: on a version tag, after
   build/sign, run the generator, commit `CHANGELOG.md`, update the GitHub
   Release body from the same source, and **publish `changelog.json` as a
   durable artifact** — the cross-repo handoff. Fully automatic; no manual
   step in the hot path.
3. **The cross-repo delivery**: the site consumes `changelog.json` WITHOUT
   a runtime third-party request (the zero-third-party law). Pick the
   static path in ADR: either the Workspace release **commits/PRs the JSON
   into `../MoggingLabs-Website`** (a repo-dispatch or a small PR the site
   redeploys from), or the site **build fetches the release artifact at
   BUILD time** (Vercel build, not client). Client stays static. Record the
   choice + why.
4. **The site `/changelog` (Website repo)**: a new route rendering
   `changelog.json` as a browsable, per-version, SEO'd page — `metadata`,
   Breadcrumb + a per-release Article/CollectionPage schema, in `sitemap.ts`
   + `llms.txt`, with an **RSS feed** so releases are subscribable
   (reuse 20's feed infra). Linked from nav/footer. Lighthouse 100.
5. **The in-app "What's new"** (Workspace): the updater surface reads the
   same `changelog.json` (one source, three faces: GitHub Release · site ·
   app). A **CHANGELOG gate** (`scripts/check-changelog.mjs`, Workspace
   qa-smokes + a `release.yml` pre-publish step) fails if the generated log
   drifts from git or the faces disagree; dry-run it against a fake tag.

## Files
- Workspace: `scripts/gen-changelog.mjs` · `scripts/check-changelog.mjs` ·
  `.github/workflows/release.yml` · `CHANGELOG.md` · the "What's new" read
  path · `docs/CONTRIBUTING.md`
- Website: `src/app/(site)/changelog/**` · a static RSS route ·
  `src/components/json-ld.tsx` · `sitemap.ts` · `public/llms.txt`
- `CHECKLIST.md` (mark 21)

## Definition of Done
- A tagged Workspace release auto-generates `CHANGELOG.md` + `changelog.json`,
  updates the Release body + the in-app "What's new", and lands on the site
  `/changelog` + RSS — zero manual editing, zero client third-party request.
- The generator is deterministic; the CHANGELOG gate is green + bite-proven
  (perturb git vs the log → red) and runs pre-publish; a fake-tag dry-run
  proves the whole path before a real release.
- `/changelog` holds Lighthouse 100 and valid schema; the three faces show
  identical entries.

## Checks that must be green
- Workspace: `typecheck` → 0; CHANGELOG gate green + fake-tag dry-run;
  release workflow lints clean. Website: `npm run build`; `/changelog`
  Lighthouse 100 ×4; `validate-schema` green; RSS validates.

## Guardrails
- Derived + gated — the changelog is never hand-edited into disagreement
  with git; the gate enforces it.
- The site consumes the JSON at BUILD time or via a committed file — never
  a client-side fetch to a third party (zero-third-party law holds).
- Deterministic generation; a real release never waits on a human to write
  notes; history is append-only.
