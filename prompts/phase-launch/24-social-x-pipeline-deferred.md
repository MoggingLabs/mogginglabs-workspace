Social amplification — DEFERRED by design (it runs only after the revamp
is live, per the plan) but DRAFTED now so the structure exists. Turn
releases, the changelog, blog posts, and industry-watch into distribution
on X (and later LinkedIn) — auto-drafted, human-approved, scheduled. Built
dormant; activated by the operator. Aligns with `../MoggingLabs-Website/
GROWTH-PLAN.md`.

## Steps
1. **The pipeline design** (`prompts/website/SOCIAL-PIPELINE.md`): the
   sources (a Workspace release → a launch thread; a blog/news post → a
   summary thread; a `/changelog` entry → a "shipped" post) → a **draft
   generator** producing platform-native copy from the SAME data those
   surfaces already emit (21's `changelog.json`, 20/22's post front-matter)
   → a **review queue** → scheduled posting. Event-driven off the existing
   pipelines, not a new content source.
2. **The draft generator** (`scripts/gen-social-drafts.mjs`, dormant,
   offline): from a release/post payload, emit ready-to-review drafts
   (thread copy, suggested media, a canonical link with UTM) into a queue
   file. Pure generation — no posting, no network, $0. Voice matches the
   site's laws: **no em-dashes, no exclamation marks, no competitor names**,
   founder's tone, every claim true.
3. **The honest cost + limits note**: **drafting is $0; automated POSTING
   to X may require a paid API tier** and carries rate limits. So v1 is
   **draft-and-human-post** (the operator posts the approved draft) at $0;
   auto-post is an operator opt-in that may cost and ships wired OFF.
   LinkedIn/others same shape. No credential in either repo.
4. **Review + approval**: nothing posts unreviewed; the queue is the gate;
   a rejected draft is discarded. The newsroom's sourcing/accuracy rule
   (22) carries — a social claim about another company is nominative and
   sourced too.
5. **Sequencing**: this step is explicitly LAST in Part III's build order
   and marked **activate-after-launch** in CHECKLIST — a live, revamped site
   is the precondition the owner set. Ships as structure + a dry-run, not a
   live poster.

## Files
- `prompts/website/SOCIAL-PIPELINE.md` · `scripts/gen-social-drafts.mjs`
  (dormant, offline; in whichever repo owns the payload) · a drafts/review-
  queue convention · a UTM/link scheme · `CHECKLIST.md` (mark 24, flagged
  activate-after-launch)

## Definition of Done
- The pipeline is designed end-to-end (sources → draft → review → post) and
  the generator produces platform-native drafts OFFLINE from the existing
  payloads — zero posting, zero network, $0.
- The cost/limits note is explicit: drafting $0, auto-posting a possible
  paid X tier, so v1 = draft-and-human-post; auto-post wired OFF.
- Every path is human-approved; no credential committed; drafts obey the
  site's copy laws; marked activate-after-launch.

## Checks that must be green
- `typecheck` → 0 on the script; a dry-run emits valid, law-abiding drafts
  from a sample payload; no network call; the site + app builds untouched.

## Guardrails
- Deferred + dormant — nothing posts until the operator opts in after the
  revamp is live; the generator only drafts.
- Honest about cost — never imply free auto-posting if the X API tier isn't
  free; draft-and-human-post is the $0 default.
- Drafts obey every copy law (no em-dash, no competitor, sourced claims);
  human approval is mandatory.
