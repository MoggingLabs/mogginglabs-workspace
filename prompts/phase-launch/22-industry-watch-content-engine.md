The play that makes us a reference: an **industry-watch** track that
reports on Claude, Codex, Gemini, and agent-tooling releases — a reason to
visit and subscribe even before you download. Build the editorial ENGINE on
the existing blog + newsletter, with a human-in-the-loop guardrail that is
load-bearing. Work in `../MoggingLabs-Website`; it rides 20's blog model
and the site's laws.

## Steps
1. **The track + taxonomy**: a `category: "industry"` on the blog (20) with
   topic tags (Claude/Anthropic, Codex/OpenAI, Gemini/Google, agent-CLIs,
   MCP, releases, how-tos) and a **hub page** per major subject that ranks
   for "Claude Code updates", "Codex new features", etc. — cluster-shaped,
   interlinked, distinct in label from product posts. New pages → schema +
   sitemap + llms.txt in the same step.
2. **The source register** (`prompts/website/RESEARCH-SOURCES.md`): the
   PRIMARY feeds to monitor — official changelogs, release notes, docs,
   repos, verified accounts — the citation base. Secondary sources
   corroborate, never sole-source a claim.
3. **The newsroom workflow** (`prompts/website/NEWSROOM.md`): a repeatable
   playbook — gather from the register (a research pass may assist), draft a
   roundup/explainer with EVERY factual claim linked to a primary source,
   then **human review before publish**. A sustainable cadence (a weekly
   roundup + event-driven posts), not a daily promise; tie the roundup into
   the existing **newsletter (Loops)** so subscribers get it.
4. **News SEO within the laws**: honored publishDate/updatedDate, Article/
   NewsArticle JSON-LD, ping the sitemap on publish, evergreen "what
   is / how to" explainers that keep ranking between beats — all at zero
   third-party requests and Lighthouse 100 (no embeds that break either).
5. **The accuracy + legal firewall** (in NEWSROOM.md, matching the site's
   existing rules): cite primary sources; separate fact from opinion;
   correct + date errors transparently; **third-party names are nominative
   only, never implying endorsement**; **never name a competitor as a
   rival** (the site's standing rule — report the ecosystem, don't
   position against BridgeMind); link + summarize, never scrape/republish.

## Files
- `../MoggingLabs-Website/src/lib/posts.ts` (industry category + posts) ·
  `src/app/(site)/` industry hub pages · `src/components/json-ld.tsx`
  (NewsArticle helper) · `prompts/website/RESEARCH-SOURCES.md` +
  `NEWSROOM.md` · `sitemap.ts` · `public/llms.txt` · the newsletter tie-in
  · `CHECKLIST.md` (mark 22)

## Definition of Done
- The industry track + taxonomy + per-subject hub pages exist, cluster-
  shaped with valid schema; news reads distinctly from product posts.
- RESEARCH-SOURCES lists the primary feeds; NEWSROOM defines the research-
  to-draft workflow, the cadence, the newsletter tie-in, and the accuracy/
  legal firewall.
- Any automation drafts into a review queue only; nothing about another
  company publishes without human review + primary-source citations.

## Checks that must be green
- `npm run build` clean; `validate-schema` green on hub + any seeded
  explainer; Lighthouse 100 ×4; em-dash grep → 0; competitor-name grep → 0;
  deploy-preview through the edge.

## Guardrails
- HUMAN-IN-THE-LOOP is absolute — no unattended publishing of AI-drafted
  news about other companies; every claim is sourced.
- Nominative use only; report the ecosystem, never position against a named
  rival (the site's law); no scraped/republished content.
- Sustainable cadence over a daily promise; zero third-party, Lighthouse
  100 hold on every news page.
