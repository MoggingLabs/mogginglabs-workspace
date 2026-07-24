// GENERATED shape, maintained by hand-adding one import per catalog file (the
// CATSCHEMA gate validates the data; the unit suite asserts this index is
// COMPLETE against the directory). Static imports, deliberately: import.meta.glob
// exists only under vite, and the pure smokes (tsx) and vitest must resolve the
// catalog identically to the built app.
import type { ProviderEntry } from '../../../contracts/integrations/provider-catalog'

import p_airtable from '../../../contracts/integrations/catalog/airtable.json'
import p_asana from '../../../contracts/integrations/catalog/asana.json'
import p_atlassian from '../../../contracts/integrations/catalog/atlassian.json'
import p_aws_api from '../../../contracts/integrations/catalog/aws-api.json'
import p_azure from '../../../contracts/integrations/catalog/azure.json'
import p_box from '../../../contracts/integrations/catalog/box.json'
import p_canva from '../../../contracts/integrations/catalog/canva.json'
import p_cf_ai_gateway from '../../../contracts/integrations/catalog/cf-ai-gateway.json'
import p_cf_auditlogs from '../../../contracts/integrations/catalog/cf-auditlogs.json'
import p_cf_autorag from '../../../contracts/integrations/catalog/cf-autorag.json'
import p_cf_bindings from '../../../contracts/integrations/catalog/cf-bindings.json'
import p_cf_browser from '../../../contracts/integrations/catalog/cf-browser.json'
import p_cf_casb from '../../../contracts/integrations/catalog/cf-casb.json'
import p_cf_containers from '../../../contracts/integrations/catalog/cf-containers.json'
import p_cf_dex from '../../../contracts/integrations/catalog/cf-dex.json'
import p_cf_dns_analytics from '../../../contracts/integrations/catalog/cf-dns-analytics.json'
import p_cf_graphql from '../../../contracts/integrations/catalog/cf-graphql.json'
import p_cf_logs from '../../../contracts/integrations/catalog/cf-logs.json'
import p_cf_observability from '../../../contracts/integrations/catalog/cf-observability.json'
import p_cf_radar from '../../../contracts/integrations/catalog/cf-radar.json'
import p_clickup from '../../../contracts/integrations/catalog/clickup.json'
import p_close from '../../../contracts/integrations/catalog/close.json'
import p_cloudflare_docs from '../../../contracts/integrations/catalog/cloudflare-docs.json'
import p_deepwiki from '../../../contracts/integrations/catalog/deepwiki.json'
import p_elevenlabs from '../../../contracts/integrations/catalog/elevenlabs.json'
import p_fal from '../../../contracts/integrations/catalog/fal.json'
import p_figma from '../../../contracts/integrations/catalog/figma.json'
import p_github_mcp from '../../../contracts/integrations/catalog/github-mcp.json'
import p_gitlab from '../../../contracts/integrations/catalog/gitlab.json'
import p_globalping from '../../../contracts/integrations/catalog/globalping.json'
import p_gohighlevel from '../../../contracts/integrations/catalog/gohighlevel.json'
import p_gw_calendar from '../../../contracts/integrations/catalog/gw-calendar.json'
import p_gw_chat from '../../../contracts/integrations/catalog/gw-chat.json'
import p_gw_drive from '../../../contracts/integrations/catalog/gw-drive.json'
import p_gw_gmail from '../../../contracts/integrations/catalog/gw-gmail.json'
import p_huggingface from '../../../contracts/integrations/catalog/huggingface.json'
import p_intercom from '../../../contracts/integrations/catalog/intercom.json'
import p_jam from '../../../contracts/integrations/catalog/jam.json'
import p_jotform from '../../../contracts/integrations/catalog/jotform.json'
import p_linear from '../../../contracts/integrations/catalog/linear.json'
import p_make from '../../../contracts/integrations/catalog/make.json'
import p_monday from '../../../contracts/integrations/catalog/monday.json'
import p_n8n from '../../../contracts/integrations/catalog/n8n.json'
import p_neon from '../../../contracts/integrations/catalog/neon.json'
import p_notion from '../../../contracts/integrations/catalog/notion.json'
import p_paypal from '../../../contracts/integrations/catalog/paypal.json'
import p_plaid from '../../../contracts/integrations/catalog/plaid.json'
import p_posthog from '../../../contracts/integrations/catalog/posthog.json'
import p_postman from '../../../contracts/integrations/catalog/postman.json'
import p_prisma from '../../../contracts/integrations/catalog/prisma.json'
import p_replicate from '../../../contracts/integrations/catalog/replicate.json'
import p_sentry from '../../../contracts/integrations/catalog/sentry.json'
import p_slack from '../../../contracts/integrations/catalog/slack.json'
import p_square from '../../../contracts/integrations/catalog/square.json'
import p_stripe from '../../../contracts/integrations/catalog/stripe.json'
import p_supabase from '../../../contracts/integrations/catalog/supabase.json'
import p_tally from '../../../contracts/integrations/catalog/tally.json'
import p_vercel from '../../../contracts/integrations/catalog/vercel.json'
import p_webflow from '../../../contracts/integrations/catalog/webflow.json'
import p_zapier from '../../../contracts/integrations/catalog/zapier.json'

const ALL: readonly ProviderEntry[] = [
  p_airtable, p_asana, p_atlassian, p_aws_api, p_azure, p_box, p_canva, p_cf_ai_gateway, p_cf_auditlogs, p_cf_autorag, p_cf_bindings, p_cf_browser, p_cf_casb, p_cf_containers, p_cf_dex, p_cf_dns_analytics, p_cf_graphql, p_cf_logs, p_cf_observability, p_cf_radar, p_clickup, p_close, p_cloudflare_docs, p_deepwiki, p_elevenlabs, p_fal, p_figma, p_github_mcp, p_gitlab, p_globalping, p_gohighlevel, p_gw_calendar, p_gw_chat, p_gw_drive, p_gw_gmail, p_huggingface, p_intercom, p_jam, p_jotform, p_linear, p_make, p_monday, p_n8n, p_neon, p_notion, p_paypal, p_plaid, p_posthog, p_postman, p_prisma, p_replicate, p_sentry, p_slack, p_square, p_stripe, p_supabase, p_tally, p_vercel, p_webflow, p_zapier
] as unknown as readonly ProviderEntry[]

const byId = new Map(ALL.map((e) => [e.id, e]))

/** Every catalog entry, id-keyed. The single runtime door to the provider catalog. */
export const providerCatalog = (): readonly ProviderEntry[] => ALL
export const providerEntryFor = (id: string): ProviderEntry | undefined => byId.get(id)

/** The catalog method quirks the token seam needs (oauth method wins; absent = none). */
export function oauthQuirksFor(id: string): { tokenExpirationBuffer?: number } | undefined {
  const m = byId.get(id)?.methods.find((x) => x.kind === 'oauth')
  return m?.quirks
}

/** The declarative liveness probe for key-auth connections (Nango's verification
 *  blocks) — absent means the MCP initialize+tools/list proof is the only probe. */
export const verificationSpecFor = (id: string) => byId.get(id)?.verification

/** Rate-limit-aware retry metadata for the bridge proxy. */
export const retrySpecFor = (id: string) => byId.get(id)?.retry

/** TEST-ONLY (the TOOLPULSE/TOOLWHO/TOOLCARDS gates): register a fixture service so
 *  the catalog-driven probe selection, identity ladder, and tool cards can be proven
 *  against a local server. Rides BOTH doors — the id map and the full list (the
 *  renderer's chooser reads `providerCatalog()` over IPC). Production never calls it. */
export function injectProviderEntryForSmoke(entry: ProviderEntry): void {
  byId.set(entry.id, entry)
  ;(ALL as ProviderEntry[]).push(entry)
}
