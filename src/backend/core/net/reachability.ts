// OFFLINE ≠ BROKEN — the one network-down classifier (extracted from updater.ts for
// phase-tools/03, so the updater and the connection status engine cannot disagree
// about what "this machine is offline" looks like).
//
// These tokens are the net layer's vocabulary for "this MACHINE cannot reach anything
// right now" — Chromium's net::ERR_* from Electron's request stack, Node's errno codes
// from fetch/undici and the differential downloader. A message wearing one is a fact
// about connectivity, not about the endpoint it was aimed at: a background check that
// fails this way says nothing about the feed, the grant, or the server, and no caller
// may flip durable state on it. Anything else — a 404, a signature refusal, a parse
// error, a JSON-RPC refusal — means the endpoint was REACHED and answered, and that is
// a real failure that deserves to be loud.
export const NETWORK_DOWN_TOKENS: readonly string[] = [
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_CONNECTION_', // …REFUSED / RESET / TIMED_OUT / CLOSED / ABORTED
  'ERR_TIMED_OUT',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_NETWORK_ACCESS_DENIED',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  // undici (Node's fetch) wraps the errno one level down and surfaces these instead;
  // a fetch() probe against a dead host says "fetch failed" or names the timeout.
  'fetch failed',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'operation was aborted'
]

/** Is this failure message the MACHINE's connectivity, not the endpoint's health? */
export const isNetworkDownMessage = (message: string): boolean =>
  NETWORK_DOWN_TOKENS.some((t) => message.includes(t))
