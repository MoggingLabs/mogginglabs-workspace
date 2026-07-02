// Swarm mailbox + role manifest (Phase-4/01). A daemon-owned, IN-MEMORY message bus:
// panes coordinate by PULLING messages — the mailbox never writes into any PTY, and
// mail bodies are user/agent content that must never reach telemetry, logs, notify
// payloads, or disk (ADR 0005). It dies with the daemon by design: coordination, not
// a database. Ring-buffered (MAIL_RING_MAX), body-capped (MAIL_BODY_MAX).
import {
  MAIL_BODY_MAX,
  MAIL_RING_MAX,
  SWARM_ROLES,
  type MailMessage,
  type SwarmRole
} from '@contracts'

export class Mailbox {
  private nextId = 1
  private messages: MailMessage[] = []
  private roles = new Map<string, SwarmRole>()

  /** Append a message. Returns its id, or null when the body is invalid. */
  send(from: string, to: string, body: string): number | null {
    if (typeof body !== 'string' || !body.length) return null
    const msg: MailMessage = {
      id: this.nextId++,
      from,
      role: this.roles.get(from),
      to: to || 'all',
      body: body.slice(0, MAIL_BODY_MAX),
      ts: Date.now()
    }
    this.messages.push(msg)
    if (this.messages.length > MAIL_RING_MAX) {
      this.messages.splice(0, this.messages.length - MAIL_RING_MAX)
    }
    return msg.id
  }

  /** Messages with id > since, addressed to `forPane` or 'all'. No `forPane` = the
   *  human view (everything). Pull-only — reading never mutates. */
  read(since = 0, forPane?: string): MailMessage[] {
    return this.messages.filter(
      (m) => m.id > since && (forPane === undefined || m.to === 'all' || m.to === forPane)
    )
  }

  /** Name a pane's role. Returns false for values outside the closed union. */
  setRole(paneId: string, role: string): boolean {
    if (!(SWARM_ROLES as readonly string[]).includes(role)) return false
    this.roles.set(paneId, role as SwarmRole)
    return true
  }

  roleOf(paneId: string): SwarmRole | undefined {
    return this.roles.get(paneId)
  }

  /** A pane is gone — its role goes with it (pane ids may be reused by new panes). */
  clearRole(paneId: string): void {
    this.roles.delete(paneId)
  }
}
