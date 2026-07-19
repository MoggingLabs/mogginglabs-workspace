The blog is a real route with one post. Grow it into an owned channel —
the content model, the SEO wiring, an editorial system, and a first set of
product/engineering posts — without breaking a single site law (zero
third-party, Lighthouse 100, founder's voice). Work in
`../MoggingLabs-Website`; extend `src/lib/posts.ts`, do not swap it for a
CMS or MDX runtime.

## Steps
1. **Mature the model** (`src/lib/posts.ts`): extend the typed `Post`
   with `author`, `tags`, `category` (product · engineering · industry —
   22 owns industry), and a cover-image convention using the existing
   static OG pipeline. Keep it file-based + static; no runtime dependency,
   no third-party request. The header rule stays: every claim true at
   publish, traced to site facts.
2. **Archive + discovery pages** (`/blog`, `/blog/tag/[tag]`, author
   pages): the index lists + paginates, tag pages are cluster hubs
   (interlinked, feeding the topic-cluster gate's spirit), each with
   `metadata` + Breadcrumb/CollectionPage JSON-LD. Add an **RSS/Atom feed**
   (a static route) so releases and posts are subscribable; link it in the
   head and `llms.txt`.
3. **Editorial system** (`prompts/website/EDITORIAL.md` or the site's
   convention): the workflow (draft → adversarial fact-check → publish via
   deploy), the **style guide** enforcing the laws (no em-dash, no
   exclamation, no AI-tell, no competitor names, founder voice), and the
   per-post SEO checklist (target intent, unique title/description,
   internal links to /learn + /docs, one takeaway).
4. **The launch post set** (3-5 real posts, in `posts.ts`): the Brain
   ("your agents share one map"), the neutrality/BYO-no-credits wedge, a
   technical deep-dive (the daemon/worktree model or the perception
   budget), a "16 agents, one workspace" how-to, and the accounts /
   Free-Pro-Team-Enterprise story. Each targets a /learn cluster keyword and links into docs.
5. **Verify the laws** on every new page: `npm run build` clean, valid
   schema, Lighthouse 100/100/100/100, greps at 0, sitemap + llms.txt +
   RSS updated in the same step.

## Files
- `../MoggingLabs-Website/src/lib/posts.ts` · `src/app/(site)/blog/**`
  (index, tag, author, [slug]) · a static RSS route · `src/components/
  json-ld.tsx` (CollectionPage helper if needed) · `src/app/sitemap.ts` ·
  `public/llms.txt` · `EDITORIAL.md` · `CHECKLIST.md` (mark 20)

## Definition of Done
- The blog renders posts with author/tags/category, Article + Breadcrumb
  schema, tag/author archives, and a valid RSS feed; drafts never build.
- `EDITORIAL.md` defines the workflow, the law-enforcing style guide, and
  the per-post SEO checklist.
- 3-5 real, true, on-voice launch posts live, each targeting a cluster
  keyword and linked into /learn + /docs; every page holds Lighthouse 100.

## Checks that must be green
- `npm run build` clean; `validate-schema` green on every post + archive;
  Lighthouse 100 ×4; em-dash + competitor greps → 0; RSS validates;
  deploy-preview verified through the edge.

## Guardrails
- Extend `posts.ts` in its idiom — no MDX runtime, no CMS, nothing adding a
  third-party request or denting Lighthouse.
- Every post claim is true at publish and in the founder's voice; opinion
  is labeled; no competitor is ever named.
- Drafts stay unpublished; a new post updates sitemap + llms.txt + RSS.
