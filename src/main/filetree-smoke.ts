import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated file-tree smoke (MOGGING_FILETREE, Phase-11/02). Drives the virtualized
// tree through the DEV harness (`__mogging.filetree`) — real `explorer:list` behind a
// spy for laziness/refusals/cap, a synthetic in-renderer listing for the 10k-row
// scroll and the hostile filename (Windows cannot even create `<`/`>` names on disk).
// Zero network. Asserts:
//   (a) 10k rows scroll end-to-end: DOM rows ≤ viewport + 2×overscan at every frame,
//       0 frames > 100ms (MOGGING_CI_GPU=soft relaxes to ≤5, loudly);
//   (b) lazy: no dir is listed before its first expand (spy on the injected loader);
//   (c) the full APG keyboard walk, mouse-free, roving tabindex exactly one 0;
//   (d) aria-level/setsize/posinset correct on a 5-deep chain (virtualized-tree ARIA);
//   (e) type-ahead jumps within visible rows; Esc clears the buffer;
//   (f) a denied dir renders an inline refusal row — no crash, tree stays live;
//   (g) a hostile filename renders as TEXT — no element injected, no handler run;
//   (h) a REAL double-click (click, click, dblclick) OPENS a directory. It used to net a
//       flicker: click 2 landed on the row click 1 had just rebuilt, and shut it again;
//   (i) the type-ahead buffer TIMES OUT (an immortal buffer made the next lone keystroke a
//       search for "za", stuck), and a repeated letter CYCLES to the next match (APG);
//   (j) an empty ROOT is still a tree: every child of role="tree" is a treeitem or a group.
//       The root-empty case used to append a roleless EmptyState <div> into the tree;
//   plus: the capped tail row on a 10k-file dir, the repo pill, the (empty) row.
// Verdict: out/filetree-result.json.

interface Fixture {
  root: string
  locked: string
  deniedCreated: boolean
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mog-ftree-'))
  mkdirSync(join(root, 'Apple')) // empty dir -> the (empty) meta row
  mkdirSync(join(root, 'nested', 'inner'), { recursive: true })
  writeFileSync(join(root, 'nested', 'inner', 'leaf.txt'), 'leaf\n')
  for (const f of ['alpha.txt', 'zulu.txt']) writeFileSync(join(root, f), f + '\n')

  // The 5-deep chain: c1/c2/c3/c4/c5, each holding its own file.
  let chain = root
  for (let i = 1; i <= 5; i++) {
    chain = join(chain, 'c' + i)
    mkdirSync(chain)
    writeFileSync(join(chain, `n${i}.txt`), '')
  }

  // The 10k-file dir — the cap + tail-row + real-scroll subject.
  const big = join(root, 'big')
  mkdirSync(big)
  for (let i = 0; i < 10000; i++) writeFileSync(join(big, 'f' + String(i).padStart(5, '0')), '')

  // A really unreadable folder — the folderpick recipe verbatim, verify included.
  const locked = join(root, 'locked')
  mkdirSync(locked)
  let deniedCreated = false
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [locked, '/deny', `${process.env.USERNAME}:(RX)`], { stdio: 'ignore', windowsHide: true })
      deniedCreated = true
    } else if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      chmodSync(locked, 0o000)
      deniedCreated = true
    }
  } catch {
    /* couldn't create the condition — the smoke says so rather than pretending */
  }
  if (deniedCreated) {
    try {
      readdirSync(locked)
      deniedCreated = false
    } catch {
      /* good — the deny binds */
    }
  }
  return { root, locked, deniedCreated }
}

function cleanup(f: Fixture): void {
  try {
    if (process.platform === 'win32') execFileSync('icacls', [f.locked, '/remove:d', String(process.env.USERNAME)], { stdio: 'ignore', windowsHide: true })
    else chmodSync(f.locked, 0o700)
  } catch {
    /* best effort */
  }
  try {
    rmSync(f.root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

const HOSTILE = '<img src=x onerror="window.__pwned=1">.txt'

export function runFileTreeSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 240000) // safety net (10k files + a full app boot)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // Renderer helpers, injected per call site. ROW_H/OVERSCAN mirror the component's
  // exported constants; bound() is the DOM-row ceiling the virtualizer promises.
  const H = `
    const rows = () => [...document.querySelectorAll('.ft-dev-host .ft-row')]
    const names = () => rows().map((r) => r.querySelector('.ft-name').textContent)
    const rowBy = (n) => rows().find((r) => r.querySelector('.ft-name').textContent === n)
    const scroller = () => document.querySelector('.ft-dev-host .file-tree')
    const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    const focName = () => document.activeElement?.querySelector?.('.ft-name')?.textContent ?? ''
    const roving = () => rows().filter((r) => r.tabIndex === 0).length
    const bound = () => Math.ceil(scroller().clientHeight / 28) + 1 + 2 * 8
    const aria = (n) => { const r = rowBy(n); return r ? { level: r.getAttribute('aria-level'), pos: r.getAttribute('aria-posinset'), size: r.getAttribute('aria-setsize'), expanded: r.getAttribute('aria-expanded') } : null }
  `

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const fx = makeFixture()
    try {
      const R = JSON.stringify(fx.root)
      await sleep(1200)

      // ── mount on the REAL channel, spy on the loader ──────────────────────────
      await ES(`window.__mogging.filetree.mount(${R})`)
      await sleep(600)
      const initial = await ES<{ names: string[]; calls: string[]; roving: number }>(
        `(() => {${H} return { names: names(), calls: window.__mogging.filetree.calls(), roving: roving() } })()`
      )
      const orderOk =
        initial.names.join(',') === ['Apple', 'big', 'c1', 'locked', 'nested', 'alpha.txt', 'zulu.txt'].join(',')
      // (b) lazy, half one: mounting listed the ROOT and nothing else.
      const lazyMountOk = initial.calls.length === 1 && initial.calls[0] === fx.root

      // (b) lazy, half two: a dir is listed exactly on its first expand.
      await ES(`(() => {${H} rowBy('nested').click() })()`)
      await sleep(500)
      const afterNested = await ES<{ calls: string[]; names: string[] }>(
        `(() => {${H} return { calls: window.__mogging.filetree.calls(), names: names() } })()`
      )
      const nestedPath = join(fx.root, 'nested')
      const innerPath = join(fx.root, 'nested', 'inner')
      const lazyExpandOk =
        afterNested.calls.includes(nestedPath) && !afterNested.calls.includes(innerPath) && afterNested.names.includes('inner')
      await ES(`(() => {${H} rowBy('inner').click() })()`)
      await sleep(500)
      const afterInner = await ES<{ calls: string[]; names: string[] }>(
        `(() => {${H} return { calls: window.__mogging.filetree.calls(), names: names() } })()`
      )
      const lazyOk = lazyMountOk && lazyExpandOk && afterInner.calls.includes(innerPath) && afterInner.names.includes('leaf.txt')

      // ── (c) the APG walk, mouse-free (fresh mount) ────────────────────────────
      await ES(`window.__mogging.filetree.mount(${R})`)
      await sleep(600)
      await ES(`window.__mogging.filetree.focusList()`)
      const walk1 = await ES<{ start: string; roving: number }>(`(() => {${H} return { start: focName(), roving: roving() } })()`)
      await ES(`(() => {${H} key('ArrowDown'); key('ArrowDown') })()`)
      const atC1 = await ES<string>(`(() => {${H} return focName() })()`)
      await ES(`(() => {${H} key('ArrowRight') })()`) // closed dir: opens, focus stays
      await sleep(500)
      const opened = await ES<{ foc: string; aria: string | null; hasC2: boolean; twist: boolean }>(`(() => {${H}
        return { foc: focName(), aria: aria('c1')?.expanded ?? null, hasC2: names().includes('c2'), twist: !!rowBy('c1').querySelector('.ft-twist.is-open') }
      })()`)
      await ES(`(() => {${H} key('ArrowRight') })()`) // open dir: to first child
      const atC2 = await ES<string>(`(() => {${H} return focName() })()`)
      await ES(`(() => {${H} key('ArrowLeft') })()`) // closed child: to parent
      const backAtC1 = await ES<string>(`(() => {${H} return focName() })()`)
      await ES(`(() => {${H} key('ArrowLeft') })()`) // open dir: closes, focus stays
      const closed = await ES<{ foc: string; aria: string | null; hasC2: boolean }>(`(() => {${H}
        return { foc: focName(), aria: aria('c1')?.expanded ?? null, hasC2: names().includes('c2') }
      })()`)
      await ES(`(() => {${H} key('End') })()`)
      const atEnd = await ES<string>(`(() => {${H} return focName() })()`)
      await ES(`(() => {${H} key('Home') })()`)
      const atHome = await ES<string>(`(() => {${H} return focName() })()`)
      await ES(`(() => {${H} key('PageDown') })()`)
      const afterPg = await ES<{ foc: string; roving: number }>(`(() => {${H} return { foc: focName(), roving: roving() } })()`)
      const apgOk =
        walk1.start === 'Apple' && walk1.roving === 1 &&
        atC1 === 'c1' &&
        opened.foc === 'c1' && opened.aria === 'true' && opened.hasC2 && opened.twist &&
        atC2 === 'c2' && backAtC1 === 'c1' &&
        closed.foc === 'c1' && closed.aria === 'false' && !closed.hasC2 &&
        atEnd === 'zulu.txt' && atHome === 'Apple' &&
        afterPg.foc === 'zulu.txt' && afterPg.roving === 1 // 7 rows < one page: clamps to the last row

      // ── (h) a REAL double-click opens a dir — it does not flicker shut ────────
      // The APG walk above left c1 CLOSED (`before` proves it, or this test is vacuous). A
      // native double-click is click, click, dblclick: click 1 opened c1 and repainted the
      // window, and click 2 hit the NEW node and toggled it right back. The gesture did
      // nothing. `detail` is what tells the second click of a sequence to stand down.
      const dbl = await ES<{ before: string | null; expanded: string | null; hasC2: boolean }>(`(async () => {${H}
        const before = aria('c1')?.expanded ?? null
        const hit = (node, type, detail) => node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail }))
        hit(rowBy('c1'), 'click', 1)
        const again = rowBy('c1') // click 1 rebuilt the row the pointer is still sitting on
        hit(again, 'click', 2)
        hit(again, 'dblclick', 2)
        await new Promise((r) => setTimeout(r, 800)) // c1's children land
        return { before, expanded: aria('c1')?.expanded ?? null, hasC2: names().includes('c2') }
      })()`)
      const dblclickOk = dbl.before === 'false' && dbl.expanded === 'true' && dbl.hasC2

      // ── (d) virtualized-tree ARIA on the 5-deep chain ─────────────────────────
      await ES(`window.__mogging.filetree.reveal(${JSON.stringify(join(fx.root, 'c1', 'c2', 'c3', 'c4', 'c5', 'n5.txt'))})`)
      await sleep(800)
      const chain = await ES<{ c2: Record<string, string> | null; c5: Record<string, string> | null; n1: Record<string, string> | null; n5: Record<string, string> | null; sel: boolean }>(
        `(() => {${H} return { c2: aria('c2'), c5: aria('c5'), n1: aria('n1.txt'), n5: aria('n5.txt'), sel: !!rowBy('n5.txt')?.classList.contains('is-selected') } })()`
      )
      const ariaOk =
        chain.c2?.level === '2' && chain.c2?.pos === '1' && chain.c2?.size === '2' &&
        chain.c5?.level === '5' && chain.c5?.pos === '1' && chain.c5?.size === '2' &&
        chain.n1?.level === '2' && chain.n1?.pos === '2' && chain.n1?.size === '2' &&
        chain.n5?.level === '6' && chain.n5?.pos === '1' && chain.n5?.size === '1' &&
        chain.sel === true

      // ── (e) type-ahead jumps; Esc clears the buffer ───────────────────────────
      await ES(`window.__mogging.filetree.focusList()`)
      await ES(`(() => {${H} key('z') })()`)
      const atZ = await ES<string>(`(() => {${H} return focName() })()`)
      await ES(`(() => {${H} key('Escape'); key('a') })()`)
      const atA = await ES<string>(`(() => {${H} return focName() })()`)
      // 'a' finds the first match AFTER zulu.txt, wrapping — 'Apple'. A stale buffer
      // ('za') would match nothing and leave focus on zulu.txt.
      const typeAheadOk = atZ === 'zulu.txt' && atA === 'Apple'

      // ── (i) the buffer times out, and a repeated letter cycles ────────────────
      // Esc was the ONLY way the buffer ever died. Press 'z', walk away, come back and press
      // 'a': the tree searched for "za", matched nothing, and left you standing on zulu.txt.
      await ES(`(() => {${H} key('End'); key('z') })()`) // -> zulu.txt (the last row), buffer 'z'
      await sleep(900) // past TYPE_AHEAD_MS: the buffer must be gone on its own, with no Esc
      await ES(`(() => {${H} key('a') })()`)
      const afterTimeout = await ES<string>(`(() => {${H} return focName() })()`)
      // APG's same-letter rule: 'aa' is not a search for "aa" — nothing is named that, and the
      // old loop sat on the first match forever. It means "the next thing starting with a", so
      // from zulu.txt the first press wraps to Apple and the second CYCLES on to alpha.txt.
      await ES(`(() => {${H} key('End'); key('a'); key('a') })()`) // one tick: well inside the window
      const cycled = await ES<string>(`(() => {${H} return focName() })()`)
      const typeAheadResetOk = afterTimeout === 'Apple' && cycled === 'alpha.txt'

      // ── the (empty) meta row on an expanded empty dir ─────────────────────────
      await ES(`(() => {${H} rowBy('Apple').click() })()`)
      await sleep(400)
      const emptyRowOk = await ES<boolean>(`(() => {${H} return names().includes('(empty)') })()`)

      // ── (f) a denied dir is an inline refusal row, not a crash ────────────────
      await ES(`(() => {${H} rowBy('locked').click() })()`)
      await sleep(500)
      const denied = await ES<{ refusal: boolean; alive: number }>(`(() => {${H}
        return { refusal: !!document.querySelector('.ft-dev-host .ft-row--refusal'), alive: rows().length }
      })()`)
      const refusalOk = fx.deniedCreated ? denied.refusal && denied.alive > 0 : denied.alive > 0

      // ── the capped tail on the REAL 10k-file dir ──────────────────────────────
      await ES(`(() => {${H} rowBy('big').click() })()`)
      await sleep(2500) // 10k dirents: readdir + sort + one IPC hop
      const capped = await ES<{ tail: boolean; dom: number; bound: number; height: number }>(`(async () => {${H}
        const s = scroller()
        s.scrollTop = s.scrollHeight
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        return {
          tail: names().some((n) => /capped at 1,?000/i.test(n)),
          dom: rows().length,
          bound: bound(),
          height: parseInt(document.querySelector('.ft-dev-host .ft-body').style.height, 10)
        }
      })()`)
      const capOk = capped.tail && capped.dom <= capped.bound && capped.height >= 1000 * 28

      // ── (j) an empty ROOT is still a tree ─────────────────────────────────────
      // `Apple` is the fixture's empty dir; mounted AS the root it has zero children. That
      // case used to append an EmptyState — a roleless <div> — straight into role="tree", so
      // the tree's only child was not a treeitem: invalid ARIA, and nothing a screen reader
      // can walk. (Re-rooting here rather than making a sixth fixture dir keeps (a)'s order
      // assertion honest.) A tree owns treeitems and groups. Nothing else.
      await ES(`window.__mogging.filetree.mount(${JSON.stringify(join(fx.root, 'Apple'))})`)
      await sleep(600)
      const hollow = await ES<{ roles: string[]; names: string[] }>(`(() => {${H}
        const kids = [...document.querySelectorAll('.ft-dev-host .file-tree[role="tree"] .ft-body > *')]
        return { roles: kids.map((k) => k.getAttribute('role') ?? ''), names: names() }
      })()`)
      const emptyRootOk =
        hollow.roles.length > 0 && // never vacuous: the tree must actually be showing something
        hollow.roles.every((r) => r === 'treeitem' || r === 'group') &&
        hollow.names.includes('(empty)')

      // ── (g) hostile filename + (a) the 10k-row synthetic scroll ──────────────
      await ES(`window.__mogging.filetree.mountSynthetic(10, 1000, ${JSON.stringify(HOSTILE)})`)
      await sleep(400)
      const hostile = await ES<{ text: boolean; img: boolean; pwned: boolean; pill: boolean; pillOff: boolean }>(`(() => {${H}
        const r = rowBy(${JSON.stringify(HOSTILE)})
        return {
          text: !!r && r.querySelector('.ft-name').textContent === ${JSON.stringify(HOSTILE)},
          img: !!document.querySelector('.ft-dev-host img'),
          pwned: '__pwned' in window,
          pill: !!rowBy('d000')?.querySelector('.pill'),
          pillOff: !!rowBy('d001')?.querySelector('.pill')
        }
      })()`)
      const hostileOk = hostile.text && !hostile.img && !hostile.pwned
      const pillOk = hostile.pill && !hostile.pillOff

      await ES(`window.__mogging.filetree.setExpanded(${JSON.stringify(Array.from({ length: 10 }, (_, i) => '/synth/d' + String(i).padStart(3, '0')))})`)
      await sleep(600)
      const perf = await ES<{ frames: number; slow: number; maxGap: number; maxDom: number; bound: number; total: number }>(`(async () => {${H}
        const s = scroller()
        s.scrollTop = 0
        await new Promise((r) => requestAnimationFrame(r))
        const gaps = []
        const samples = []
        let last = performance.now()
        await new Promise((res) => {
          const step = () => {
            const now = performance.now()
            gaps.push(now - last)
            last = now
            samples.push(rows().length)
            if (s.scrollTop >= s.scrollHeight - s.clientHeight - 1) return res()
            s.scrollTop = s.scrollTop + 1120 // ~40 rows per frame: end-to-end in ~250 frames
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
        const warm = gaps.slice(3) // ignore the mount/first-paint frames
        return {
          frames: gaps.length,
          slow: warm.filter((g) => g > 100).length,
          maxGap: Math.round(Math.max(...warm)),
          maxDom: Math.max(...samples),
          bound: bound(),
          total: document.querySelectorAll('.ft-dev-host .ft-row').length && Math.round(parseInt(document.querySelector('.ft-dev-host .ft-body').style.height, 10) / 28)
        }
      })()`)
      // Software-GL CI runners get a relaxed frame budget — printed loudly, never silent.
      const gpuSoft = process.env.MOGGING_CI_GPU === 'soft'
      const scrollOk = perf.total >= 10010 && perf.maxDom <= perf.bound && (gpuSoft ? perf.slow <= 5 : perf.slow === 0)

      const pass =
        orderOk && lazyOk && apgOk && ariaOk && typeAheadOk && emptyRowOk && refusalOk && capOk && hostileOk && pillOk && scrollOk &&
        dblclickOk && typeAheadResetOk && emptyRootOk
      result = {
        pass,
        orderOk, initial,
        lazyOk, lazyMountOk, lazyExpandOk,
        apgOk, walk1, atC1, opened, atC2, backAtC1, closed, atEnd, atHome, afterPg,
        dblclickOk, dbl,
        ariaOk, chain,
        typeAheadOk, atZ, atA,
        typeAheadResetOk, afterTimeout, cycled,
        emptyRootOk, hollow,
        emptyRowOk,
        refusalOk, deniedCreated: fx.deniedCreated, denied,
        capOk, capped,
        hostileOk, hostile, pillOk,
        scrollOk, perf, gpuSoft,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    cleanup(fx)
    try {
      writeFileSync(join(process.cwd(), 'out', 'filetree-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
