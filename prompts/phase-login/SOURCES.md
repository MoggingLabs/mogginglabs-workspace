# SOURCES

External research behind this pack. Gathered 2026-07-09. Links were live at that
date; treat pricing as decayed after ~6 months.

## Electron: cracking, and what hardening buys

- [Cracking Electron apps open — fasterthanli.me](https://fasterthanli.me/articles/cracking-electron-apps-open) — `app.asar` is an archive; one command extracts it, regardless of installer format.
- [Cracking Electron — taner-dev](https://taner-dev.com/articles/crack-electron) — end-to-end walkthrough: unpack, patch the license check, recompute the integrity hash, repack. Notes the one feature he *couldn't* crack was server-side AI generation.
- [Reverse engineering Electron apps to discover APIs — danaepp](https://danaepp.com/reverse-engineering-electron-apps-to-discover-apis)
- [Instrumenting Electron apps — Doyensec](https://blog.doyensec.com/2018/07/19/instrumenting-electron-app.html)
- [ASAR integrity bypass — InfoSec Write-ups](https://infosecwriteups.com/electron-js-asar-integrity-bypass-431ac4269ed5) — strip signature, patch, recompute, ad-hoc re-sign.
- [macOS Electron application injection — HackTricks](https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-proces-abuse/macos-electron-applications-injection.html) — `ELECTRON_RUN_AS_NODE` as a living-off-the-land technique.
- [Quasar / V8 heap-snapshot injection — Taggart Tech](https://taggart-tech.com/quasar-electron/) — integrity checks historically missed heap snapshots.

### Official Electron docs
- [Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) — `RunAsNode`, `EnableNodeCliInspectArguments`, `EnableNodeOptionsEnvironmentVariable`, `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`. Note: disabling `RunAsNode` breaks `child_process.fork()` — migrate to `UtilityProcess`.
- [ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) — both fuses are **off by default** and must be enabled together. macOS ≥16 (`Info.plist` `ElectronAsarIntegrity`); Windows ≥30 (resource entry).
- [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) — DPAPI / Keychain / libsecret; Linux `basic_text` fallback is a hardcoded key.
- [electron-builder: adding Electron fuses](https://www.electron.build/tutorials/adding-electron-fuses.html)
- [Electron credential storage security — Chen](https://chenguangliang.com/en/posts/blog169_electron-credential-storage-security/) — fixed AES-128-CBC with a hardcoded IV.

## Auth for native/desktop clients

- [RFC 8252 — OAuth 2.0 for Native Apps](https://datatracker.ietf.org/doc/html/rfc8252) · [rfc-editor](https://www.rfc-editor.org/rfc/rfc8252.html)
- [oauth.net — native apps](https://oauth.net/2/native-apps/)
- [Securing Electron apps with OpenID Connect + OAuth 2 — Auth0](https://auth0.com/blog/securing-electron-applications-with-openid-connect-and-oauth-2/) — why an embedded login form is wrong.
- [Google — OAuth 2.0 for native apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Deep-link authentication with Electron + Supabase](https://medium.com/@paul.pietzko/deeplink-authentication-with-electron-and-supabase-2992d18501da)

## Auth providers (pricing as of 2026-07)

- [WorkOS pricing](https://workos.com/pricing) — 1M MAU free. · [AuthKit sessions](https://workos.com/docs/authkit/sessions) — rotation + reuse detection.
- [Clerk pricing](https://clerk.com/pricing) · [`revokeSession()`](https://clerk.com/docs/reference/backend/sessions/revoke-session) — cleanest instant-revoke.
- [Supabase pricing](https://supabase.com/pricing) · [sessions / global signOut](https://supabase.com/docs/guides/auth/sessions) — single-session-per-user is a built-in Pro feature.
- [Firebase / Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)
- [Auth0 pricing analysis](https://auth0pricing.com/)
- [better-auth 1.5 — Electron integration](https://better-auth.com/blog/1-5) · [security / RFC 7009 revoke](https://better-auth.com/docs/reference/security)

> **Load-bearing caveat:** every provider above leaves a stateless access JWT
> valid until it expires. None of them can instantly kill a session. Device
> kicking must go through our own lease.

## Billing / merchant of record

- [Polar — MoR fees](https://polar.sh/docs/merchant-of-record/fees) — 5%+50¢ Starter; 3.4–3.8% on paid tiers.
- [Paddle pricing](https://www.paddle.com/pricing) — 5%+50¢, no monthly fee.
- [Lemon Squeezy 2026 update](https://www.lemonsqueezy.com/blog/2026-update) — Stripe-owned, funnelling to Stripe Managed Payments. **Invite-gated; don't build new on it.**
- [Stripe Managed Payments — tax compliance](https://docs.stripe.com/payments/managed-payments/tax-compliance) — Stripe's own MoR, public preview Feb 2026.
- [Stripe Entitlements](https://docs.stripe.com/billing/entitlements) — GA and usable.
- [Stripe Tax vs merchant of record](https://fungies.io/stripe-tax-limitations-understanding-the-difference-from-the-merchant-of-record-model/) — Stripe Tax calculates; you stay liable.
- [Stripe — checkout from a desktop/mobile app](https://docs.stripe.com/mobile/digital-goods/checkout) — open system browser, return via deep link.

## Hosting, lease primitive, database

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [What are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) — single-threaded, one request at a time; "no race conditions, no distributed locks." **This is the lease primitive.**
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [Neon pricing](https://neon.com/pricing) · [Turso pricing](https://turso.tech/pricing) · [PlanetScale pricing](https://planetscale.com/pricing) (no free tier)
- [Fly.io pricing](https://fly.io/pricing/) · [Railway vs Render](https://northflank.com/blog/railway-vs-render) · [Hetzner Cloud](https://www.hetzner.com/cloud)

## Device binding, leases, single-session

- [Keygen — machines API](https://keygen.sh/docs/api/machines/) · [floating licenses](https://keygen.sh/docs/choosing-a-licensing-model/floating-licenses/) — 10-minute default heartbeat window, auto-deactivation of dead nodes.
- [JetBrains floating licenses](https://www.jetbrains.com/help/ide-services/floating-licenses.html) — checkout on launch, auto-renew, "save your work" warning on server loss.
- [Okta — enforce single active session](https://support.okta.com/help/s/question/0D5KZ00000b0eeu0AA/how-to-enforce-single-active-session-per-user-across-devices) · [Ory — revoke active sessions](https://www.ory.com/docs/actions/revoke-active-sessions)
- [Netflix — device limits](https://help.netflix.com/en/node/29) — floating concurrent-stream slots by plan; install anywhere, stream on N.
- [Windows machine identity is unstable](https://www.nextofwindows.com/the-best-way-to-uniquely-identify-a-windows-machine) · [macOS VM clone UUID collisions](https://communities.vmware.com/t5/ESXi-Discussions/OS-X-Guest-cloning-deployment-best-practices/td-p/1699090)
- [Cursor's hallucinated one-device policy → real cancellations — HN](https://news.ycombinator.com/item?id=43683012) — **the enforcement UX did more damage than piracy.**
- [Cursor device policy in practice](https://word-spinner.com/blog/how-many-devices-can-you-have-on-cursor-ai/)

## Offline grace, signed entitlements, fail-open

- [Tailscale — control plane vs data plane](https://tailscale.com/kb/1508/control-data-planes) — the canonical hybrid.
- [Tailscale — key expiry](https://tailscale.com/docs/features/access-control/key-expiry) — 180-day node keys.
- [JetBrains — 48-hour offline grace](https://youtrack.jetbrains.com/issue/IDEA-235906) · [offline activation codes](https://sales.jetbrains.com/hc/en-gb/articles/360016995379-Activating-JetBrains-IDEs-with-an-offline-activation-code)
- [1Password — device credential + offline unlock](https://1password.com/blog/unlock-sso-deep-dive)
- [Offline license validation — Keyforge](https://keyforge.dev/blog/offline-license-validation)
- [Ed25519 / EdDSA JWT signatures — Curity](https://curity.io/resources/learn/jwt-signatures/)
- [Clock tampering is unfixable offline — Keygen discussion](https://github.com/orgs/keygen-sh/discussions/25) — "what the offline device says the time is, is the time."

## Forced accounts in developer tools — the cautionary record

- [Insomnia 8 forces users to log in and use cloud storage — Tildes](https://tildes.net/~comp/1atr/insomnia_8_forces_users_to_login_and_use_cloud_storage)
- [Kong/insomnia #6577 — "enshittification / needing an account"](https://github.com/Kong/insomnia/issues/6577)
- [Insomnia's update locks out prev user data, forces account creation w/o warning — HN](https://news.ycombinator.com/item?id=37680522)
- [Kong/insomnia #6624 — "Employer REQUIREMENT: Cloud syncs are forbidden"](https://github.com/Kong/insomnia/issues/6624) — **the procurement argument.** Orgs had picked Insomnia *because* Postman's cloud accounts failed security review.
- [Kong/insomnia #6590 — account + local/cloud data migration](https://github.com/Kong/insomnia/discussions/6590) · [#7362 — remove forced login](https://github.com/Kong/insomnia/discussions/7362)
- [Local-only projects are back in Insomnia 8.3 (GA)](https://github.com/Kong/insomnia/discussions/6626) — **the climbdown.**
- [Discontinuing Scratchpad — Postman Community](https://community.postman.com/t/discontinuing-scratchpad/52098) · [Postman stopped supporting Scratch Pad. What next?](https://community.postman.com/t/postman-stopped-supporting-scratch-pad-what-next/52530)
- [Postman Scratch Pad removal — SailPoint developer community](https://developer.sailpoint.com/discuss/t/postman-scratch-pad-removal/19235)
- [Postman vs Insomnia vs Bruno: best API client in 2026 — DEV](https://dev.to/_d7eb1c1703182e3ce1782/postman-vs-insomnia-vs-bruno-best-api-client-in-2026-1pf7) — where the users went: Bruno (offline-first, files in git), Hoppscotch.

> **Not documented:** permanent-churn figures for either product. The backlash,
> the migration, and Insomnia's reversal are well-sourced. A quantified "exodus"
> is not — do not claim one.

## Anti-piracy ROI

- [Gabe Newell: "piracy is a service problem, not a pricing problem"](https://www.gamesradar.com/gabe-newell-piracy-issue-service-not-price/)
- [DRM punishes paying customers — HN](https://news.ycombinator.com/item?id=21307660)
- [Sublime Text's honor system — HN](https://news.ycombinator.com/item?id=8471976) · [why someone finally paid](https://lars-christian.com/posts/2025-12-18-i-finally-purchased-a-sublime-text-license/)
- [Licensing tools for an indie Mac app: the honest breakdown — dev.to](https://dev.to/nicodemanez/i-compared-the-licensing-tools-for-my-indie-mac-app-the-honest-breakdown-40a5) — ship Ed25519-signed offline leases and move on.
- [Server-authoritative validation beats client protection — arXiv 2512.21377](https://arxiv.org/pdf/2512.21377) — anti-cheat literature; the same conclusion.

## Internal references

Repo files cited throughout this pack, at commit `6c03c35`:

`README.md:8,19,30,33` · `LICENSE` · `docs/00-vision-and-positioning.md:35-37,44,56` ·
`docs/10-distribution.md` · `docs/adr/0001-electron-over-tauri.md` ·
`docs/adr/0002-never-broker-provider-auth.md` · `electron-builder.yml` ·
`src/main/window.ts:32-43` · `src/preload/index.ts:9-14` ·
`src/contracts/ipc/channels.ts:262` · `src/main/index.ts:142,149,189,201` ·
`src/main/daemon-client.ts:54,61-63` · `src/main/electron-context.ts:7` ·
`src/main/mcp-endpoint.ts:46,146,172` · `src/main/vault.ts:15,18` ·
`src/pty-daemon/index.ts:25` · `src/pty-daemon/lifecycle.ts:37-38` ·
`src/pty-daemon/transport.ts` · `src/pty-daemon/ledger.ts` ·
`bin/mogging.mjs` · `bin/mogging-mcp.mjs` · `bin/lib/endpoint-client.mjs` ·
`src/backend/features/usage/` (`cost.ts` `MODEL_PRICES`, `history.ts`,
`thresholds.ts`, `pace.ts`)
