#!/usr/bin/env node
// The operator's forensic-trace tool (ADR 0016 §leak-attribution, phase-accounts/07).
//
//   node scripts/trace-watermark.mjs <record.json> [--accounts a,b,c] [--json]
//
// Given a LEAKED activation record — the entitlement claim, or just its watermark
// carriers — recover the account it was issued to, so a leaked license points back to
// who leaked it. Input shapes accepted:
//   · { "wm": "...", "wmk": [...] }                     (bare carriers)
//   · { "accountId": "...", "watermark": { wm, wmk } }  (a decoded claim)
//   · { "watermark": { wm, wmk } }                      (a claim, id stripped)
//
// The PRIMARY carrier (`wm`) yields the exact account id on its own. If a leaker stripped
// it, the REDUNDANT carrier (`wmk`, a benign token ORDER) still attributes against a
// known-account set passed with --accounts. This is a pure mirror of the codec in
// src/backend/features/account/watermark.ts — no secret, no network; the entitlement
// JWT's own signature is the anti-forgery (the WATERMARK gate proves the round-trip).
//
// ID ONLY (invariant I6): the account id is a stable opaque handle, never a credential.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const CARRIER_TOKENS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const PERMUTATIONS = 40320 // 8!

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlToUtf8 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

const factorial = (n) => {
  let f = 1
  for (let i = 2; i <= n; i++) f *= i
  return f
}

const fingerprint = (id) => createHash('sha256').update(id).digest().readUInt32BE(0) % PERMUTATIONS

const indexOfPermutation = (items, perm) => {
  if (!Array.isArray(perm) || perm.length !== items.length) return null
  const pool = items.slice()
  let index = 0
  for (let i = 0; i < perm.length; i++) {
    const at = pool.indexOf(perm[i])
    if (at < 0) return null
    index += at * factorial(pool.length - 1)
    pool.splice(at, 1)
  }
  return index
}

function traceWatermark(carriers, knownAccounts = []) {
  let accountId = null
  let fp = null
  let attributedBy = 'none'

  const m = typeof carriers.wm === 'string' ? /^w1\.([^.]+)\.([^.]+)$/.exec(carriers.wm) : null
  if (m) {
    try {
      const id = b64urlToUtf8(m[1])
      const chk = b64url(createHash('sha256').update(id).digest().subarray(0, 6))
      if (chk === m[2]) {
        accountId = id
        fp = fingerprint(id)
        attributedBy = 'primary'
      }
    } catch {
      /* fall through to the redundant carrier */
    }
  }

  const orderFingerprint = indexOfPermutation(CARRIER_TOKENS, carriers.wmk)
  if (accountId === null && orderFingerprint !== null) {
    const hit = knownAccounts.find((a) => fingerprint(a) === orderFingerprint)
    if (hit !== undefined) {
      accountId = hit
      fp = orderFingerprint
      attributedBy = 'order'
    }
  }

  return {
    accountId,
    attributedBy,
    fingerprint: fp,
    orderFingerprint,
    carriersAgree: fp !== null && orderFingerprint !== null && fp === orderFingerprint
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────
// process.exitCode (not process.exit): a bare process.exit() right after a stdout write
// to a pipe can truncate the line before it flushes — the caller then parses nothing.
function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const accIdx = args.indexOf('--accounts')
  const knownAccounts = accIdx >= 0 && args[accIdx + 1] ? args[accIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : []
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--accounts')

  if (!file) {
    console.error('trace-watermark: usage: node scripts/trace-watermark.mjs <record.json> [--accounts a,b,c] [--json]')
    process.exitCode = 2
    return
  }

  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`trace-watermark: cannot read ${file}: ${e.message}`)
    process.exitCode = 2
    return
  }

  // Accept a bare carriers object or a claim that nests them under `watermark`.
  const carriers = record.watermark && typeof record.watermark === 'object' ? record.watermark : record
  const trace = traceWatermark({ wm: carriers.wm, wmk: carriers.wmk }, knownAccounts)

  if (asJson) {
    process.stdout.write(JSON.stringify(trace) + '\n')
  } else if (trace.accountId) {
    console.log(`account: ${trace.accountId}`)
    console.log(`attributed by: ${trace.attributedBy}  (fingerprint ${trace.fingerprint}, carriers ${trace.carriersAgree ? 'agree' : 'single'})`)
  } else {
    console.log('account: UNKNOWN (no surviving carrier attributed; pass --accounts to attribute via the redundant carrier)')
  }
  process.exitCode = trace.accountId ? 0 : 1
}

main()
