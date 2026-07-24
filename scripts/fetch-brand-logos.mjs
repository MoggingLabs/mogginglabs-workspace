// Fetch official brand marks for every provider/integration the app renders and
// generate src/ui/components/brand-logos.gen.ts. Run: node scripts/fetch-brand-logos.mjs
//
// Sources (both vector — resolution-independent, the best quality there is):
//  - simple-icons (CC0 path data of official brand marks, + the official brand hex)
//  - @lobehub/icons-static-svg (MIT, AI-brand marks; `-color` variants carry brand colors)
// The marks remain trademarks of their owners; the app renders them for identification.
//
// Near-black/near-white brand colors are dropped (the mark inherits the theme's
// text color instead) so GitHub/Vercel/Notion stay visible on dark AND light themes.

import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'components', 'brand-logos.gen.ts')

const SI = (slug) => ({ src: 'si', slug })
/** Pinned pre-removal simple-icons version: Slack/AWS/Azure were dropped from
 *  @latest over trademark policy; the old CC0 releases still carry the paths. */
const SI8 = (slug) => ({ src: 'si8', slug })
/** Same story, later wave (Canva et al. left after v13). */
const SI13 = (slug) => ({ src: 'si13', slug })
const LOBE = (slug) => ({ src: 'lobe', slug })
/** Direct file (Wikimedia Commons hosts the official multicolor marks). */
const URL_SRC = (slug, url) => ({ src: 'url', slug, url })

/** App id -> ordered source candidates (first hit wins). Ids are the ones the UI
 *  passes to providerLogo(): integration preset ids + usage-catalog provider ids. */
const WANT = {
  // ── Integrations (backend/features/integrations/presets.json) ──
  n8n: [SI('n8n')],
  google: [SI('google')], // the Google Workspace GROUP card (gw-* rows share it)
  'gw-drive': [SI('googledrive')],
  'gw-gmail': [SI('gmail')],
  'gw-calendar': [SI('googlecalendar')],
  'gw-chat': [SI('googlechat')],
  slack: [URL_SRC('wikimedia-slack', 'https://upload.wikimedia.org/wikipedia/commons/d/d5/Slack_icon_2019.svg'), SI8('slack')],
  'github-mcp': [SI('github')],
  vercel: [SI('vercel')],
  supabase: [SI('supabase')],
  gohighlevel: [SI('gohighlevel')],
  clickup: [SI('clickup')],
  make: [SI('make')],
  sentry: [SI('sentry')],
  posthog: [SI('posthog')],
  stripe: [SI('stripe')],
  'cloudflare-docs': [SI('cloudflare')],
  'aws-api': [SI('amazonwebservices'), SI8('amazonaws')],
  azure: [URL_SRC('wikimedia-azure', 'https://upload.wikimedia.org/wikipedia/commons/f/fa/Microsoft_Azure.svg'), SI8('microsoftazure')],
  gitlab: [SI('gitlab')],
  notion: [SI('notion')],
  // Tally is in no icon set; its own site ships the official mark as a square
  // SVG favicon — the best vector there is for it.
  tally: [SI('tally'), URL_SRC('tally-favicon', 'https://tally.so/favicon.svg')],
  zapier: [SI('zapier')],
  atlassian: [SI('jira'), SI('atlassian')],
  figma: [SI('figma')],
  postman: [SI('postman')],
  airtable: [SI('airtable')],
  jotform: [SI('jotform')],
  replicate: [SI('replicate'), LOBE('replicate')],
  fal: [LOBE('fal-color'), LOBE('fal')],
  elevenlabs: [SI('elevenlabs'), LOBE('elevenlabs')],
  higgsfield: [LOBE('higgsfield-color'), LOBE('higgsfield')],
  // ── Provider catalog rows that still rendered the monogram (2026-07-24) ──
  asana: [SI('asana')],
  box: [SI('box')],
  canva: [SI('canva'), SI13('canva')],
  close: [SI('close'), LOBE('close')],
  deepwiki: [LOBE('deepwiki-color'), LOBE('deepwiki'), SI('deepwiki')],
  globalping: [SI('globalping')],
  huggingface: [SI('huggingface'), LOBE('huggingface-color'), LOBE('huggingface')],
  intercom: [SI('intercom')],
  jam: [SI('jam')],
  linear: [SI('linear')],
  monday: [SI('monday'), SI('mondaydotcom'), SI8('monday')],
  neon: [SI('neon')],
  paypal: [SI('paypal'), SI8('paypal')],
  plaid: [SI('plaid'), SI8('plaid')],
  prisma: [SI('prisma')],
  square: [SI('square')],
  webflow: [SI('webflow')],
  // The Cloudflare FAMILY: thirteen capability rows + the family card, one mark.
  cloudflare: [SI('cloudflare')],
  ...Object.fromEntries(
    ['cf-ai-gateway', 'cf-auditlogs', 'cf-autorag', 'cf-bindings', 'cf-browser', 'cf-casb', 'cf-containers', 'cf-dex', 'cf-dns-analytics', 'cf-graphql', 'cf-logs', 'cf-observability', 'cf-radar'].map(
      (id) => [id, [SI('cloudflare')]]
    )
  ),
  // ── Usage catalog (contracts/usage USAGE_PROVIDERS) beyond the CLI four ──
  copilot: [SI('githubcopilot'), LOBE('copilot-color'), LOBE('copilot')],
  zed: [LOBE('zed'), SI('zedindustries')],
  kiro: [LOBE('kiro-color'), LOBE('kiro')],
  kilo: [LOBE('kilocode-color'), LOBE('kilocode'), LOBE('kilo')],
  augment: [LOBE('augment-color'), LOBE('augment'), LOBE('augmentcode')],
  jetbrains: [SI('jetbrains')],
  codebuff: [LOBE('codebuff')],
  windsurf: [LOBE('windsurf')],
  openrouter: [LOBE('openrouter')],
  deepseek: [LOBE('deepseek-color'), LOBE('deepseek')],
  moonshot: [LOBE('moonshot')],
  deepgram: [SI('deepgram'), LOBE('deepgram')],
  litellm: [LOBE('litellm-color'), LOBE('litellm')],
  minimax: [LOBE('minimax-color'), LOBE('minimax')],
  zai: [LOBE('zai'), LOBE('zhipu-color'), LOBE('zhipu')],
  venice: [LOBE('venice-color'), LOBE('venice')],
  poe: [LOBE('poe')],
  chutes: [LOBE('chutes')],
  groqcloud: [LOBE('groq'), SI('groq')],
  llmproxy: [],
  clawrouter: [],
  crof: [],
  doubao: [LOBE('doubao-color'), LOBE('doubao')],
  warp: [SI('warp'), LOBE('warp')],
  alibaba: [LOBE('alibabacloud-color'), LOBE('alibabacloud'), SI('alibabacloud')],
  'alibaba-web': [LOBE('alibabacloud-color'), LOBE('alibabacloud'), SI('alibabacloud')],
  'openai-admin': [LOBE('openai')],
  'claude-admin': [LOBE('claude-color')],
  vertex: [LOBE('vertexai-color'), LOBE('vertexai'), LOBE('vertex')],
  bedrock: [LOBE('bedrock-color'), LOBE('bedrock')],
  cursor: [LOBE('cursor')],
  devin: [LOBE('devin')],
  manus: [LOBE('manus')],
  t3chat: [LOBE('t3-color'), LOBE('t3'), LOBE('t3chat')],
  kimi: [LOBE('kimi-color'), LOBE('kimi'), LOBE('moonshot')],
  perplexity: [LOBE('perplexity-color'), LOBE('perplexity')],
  mimo: [LOBE('xiaomimimo')],
  sakana: [LOBE('sakana')],
  abacus: [LOBE('abacus')],
  'mistral-web': [LOBE('mistral-color'), LOBE('mistral')],
  amp: [LOBE('amp-color'), LOBE('amp')],
  commandcode: [],
  'opencode-web': [LOBE('opencode')],
  'grok-web': [LOBE('grok')],
  ollama: [LOBE('ollama'), SI('ollama')],
  aider: [LOBE('aider')]
}

const get = async (url) => {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) return null
    // Wikimedia files open with an XML prolog/doctype — strip before the check.
    const text = (await res.text()).replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '').trim()
    return text.startsWith('<svg') ? text : null
  } catch {
    return null
  }
}

const CANDIDATE_URL = (c) =>
  c.src === 'si'
    ? `https://unpkg.com/simple-icons@latest/icons/${c.slug}.svg`
    : c.src === 'si8'
      ? `https://unpkg.com/simple-icons@8/icons/${c.slug}.svg`
      : c.src === 'si13'
        ? `https://unpkg.com/simple-icons@13/icons/${c.slug}.svg`
      : c.src === 'lobe'
        ? `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${c.slug}.svg`
        : c.url

/** Official brand hex per simple-icons slug (their data file). */
async function siColors() {
  for (const path of ['data/simple-icons.json', '_data/simple-icons.json']) {
    try {
      const res = await fetch(`https://unpkg.com/simple-icons@latest/${path}`)
      if (!res.ok) continue
      const data = await res.json()
      const list = Array.isArray(data) ? data : data.icons
      if (!Array.isArray(list)) continue
      const bySlug = new Map()
      for (const i of list) {
        const slug =
          i.slug ??
          i.title
            .toLowerCase()
            .replace(/\+/g, 'plus')
            .replace(/\./g, 'dot')
            .replace(/&/g, 'and')
            .replace(/[ !’'.-]/g, '')
        bySlug.set(slug, i.hex)
      }
      return bySlug
    } catch {
      /* next path */
    }
  }
  return new Map()
}

const lum = (hex) => {
  const n = parseInt(hex, 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const clean = (svg) =>
  svg
    .replace(/<title>.*?<\/title>/s, '')
    .replace(/ style="[^"]*"/, '')
    .replace(/\s+height="[^"]*"/, '')
    .replace(/\s+width="[^"]*"/, '')
    .replace('<svg', '<svg height="1em" width="1em"')

const main = async () => {
  const colors = await siColors()
  const entries = {}
  const report = { found: [], missing: [] }

  for (const [id, candidates] of Object.entries(WANT)) {
    let hit = null
    for (const c of candidates) {
      const svg = await get(CANDIDATE_URL(c))
      if (svg) {
        hit = { ...c, svg }
        break
      }
    }
    if (!hit) {
      report.missing.push(id)
      continue
    }
    let svg = clean(hit.svg)
    let color
    if (hit.src === 'si' || hit.src === 'si8') {
      if (!/fill="/.test(svg)) svg = svg.replace('<svg', '<svg fill="currentColor"')
      const hex = colors.get(hit.slug)
      // Near-black/near-white marks stay adaptive (inherit the theme text color).
      if (hex && lum(hex) > 0.04 && lum(hex) < 0.92) color = `#${hex}`
    }
    entries[id] = color ? { svg, color } : { svg }
    report.found.push(`${id} <- ${hit.src}:${hit.slug}${color ? ' ' + color : ''}`)
  }

  const body = Object.entries(entries)
    .map(([id, e]) => `  ${JSON.stringify(id)}: { svg: ${JSON.stringify(e.svg)}${e.color ? `, color: ${JSON.stringify(e.color)}` : ''} }`)
    .join(',\n')
  writeFileSync(
    OUT,
    `// GENERATED by scripts/fetch-brand-logos.mjs — do not edit by hand; re-run the script.
// Official brand marks: simple-icons (CC0) + lobehub/lobe-icons (MIT). The marks are
// trademarks of their owners, rendered for identification only. \`color\` is the official
// brand hex where one exists and survives both themes; colorless entries inherit text color.

export interface BrandLogo {
  svg: string
  color?: string
}

export const BRAND_LOGOS: Record<string, BrandLogo> = {
${body}
}
`
  )
  console.log(`written ${OUT}`)
  console.log(`\nFOUND (${report.found.length}):\n` + report.found.join('\n'))
  console.log(`\nMISSING (${report.missing.length}): ${report.missing.join(', ') || '—'}`)
}

await main()
