// The poller records every review here; the worker running one is the session it records
const STATE_PATH = '.config/pr-review-board/state.json'
const CONFIG_PATH = '.config/pr-review-board/config.json'
const PANE = 'review'
const SEVERITIES = [
  { id: 'live', title: 'Live on merge', color: 'error' },
  { id: 'high', title: 'High', color: 'error' },
  { id: 'medium', title: 'Medium', color: 'warning' },
  { id: 'low-medium', title: 'Low to medium', color: 'suggestion' },
  { id: 'low', title: 'Low', color: 'permission' },
  { id: 'question', title: 'Questions', color: 'inactive' },
]
const STATUS_TAGS = {
  approved: { text: 'approved', color: 'warning' },
  posted: { text: 'posted', color: 'success' },
  dropped: { text: 'dropped', color: 'inactive' },
}
const RISK_COLORS = { high: 'error', medium: 'warning', low: 'success' }
// Where a finding comes from, measured against the code path the change replaces
const ORIGIN_TAGS = {
  new: { text: 'new', color: 'error' },
  carried: { text: 'carried over', color: 'inactive' },
  none: { text: 'not a bug', color: 'inactive' },
}

let home
let sessionId
let workspaceId
let review
let board
let boardMtime
let readError
// Comment numbers ticked for the next post, and the comments and report sections shown in full; kept only for this module's life
const picks = new Set()
const expanded = new Set()
const ALL_TABS = 'all'
let tab = ALL_TABS
let notice

export function register(on) {
  on('session.start', async ($, e, next) => {
    home = await $.env.get('HOME')
    sessionId = await $.session.id()
    workspaceId = await $.env.get('HERDR_WORKSPACE_ID')
    await refresh($)
    $.clock.every(10_000, () => refresh($))
    // The board's age moves even when the board doesn't
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    // `/review` is Claude Code's own code-review command, so the board takes a name of its own
    await $.command.register({ name: 'reviewboard', description: 'Show or hide the board for this session\'s PR review', immediate: true })
    // Only a session that runs a review gets the pane unasked; any session can still open it with the command
    if (review) await $.ui.open({ id: PANE, title: paneTitle() })
    return next(e)
  })

  on('command.run', { command: 'reviewboard' }, togglePane)

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const now = await $.clock.now()

    if (!review) {
      return Text({ dimColor: true, wrap: 'wrap', children: [readError || 'This session runs no pr-review-board review.'] })
    }
    if (!board) {
      return Box({
        flexDirection: 'column',
        children: [
          Text({ bold: true, children: [review.slug] }),
          Text({ dimColor: true, wrap: 'wrap', children: [readError || 'No board yet for ' + review.key + '.'] }),
          prList(els, review.prs),
        ],
      })
    }

    const prs = Array.isArray(board.prs) ? board.prs : review.prs
    const comments = Array.isArray(board.comments) ? board.comments : []
    const stacks = stacksOf(prs)
    // A tab whose stack left the board falls back to All
    if (!stacks.some((s) => s.id === tab)) tab = ALL_TABS
    const shown = tab === ALL_TABS ? stacks : stacks.filter((s) => s.id === tab)
    const inView = comments.filter((c) => tab === ALL_TABS || stackOf(c, prs, stacks) === tab)
    const children = [summary(els, comments)]
    if (stacks.length > 1) children.push(tabBar(els, stacks, comments, prs, $))
    children.push(prList(els, shown, stacks.length > 1 && tab === ALL_TABS))
    const open = inView.filter((c) => c.status !== 'posted')
    for (const severity of SEVERITIES) {
      const inSection = open.filter((c) => severityOf(c) === severity)
      if (inSection.length) children.push(section(els, severity, inSection, prs, $))
    }
    if (Array.isArray(board.report) && board.report.length) children.push(reportBox(els, board.report, $))
    const posted = inView.filter((c) => c.status === 'posted').sort((a, b) => a.n - b.n)
    if (posted.length) children.push(postedSection(els, posted, prs))
    const picking = pickBar(els, $)
    if (picking) children.push(picking)
    children.push(footer(Text, now))
    return Box({ flexDirection: 'column', children })
  })
}

/** A pane opened unasked in a narrow terminal stays open but unplaced; the command shows it rather than closing it. */
async function togglePane($) {
  const pane = (await $.ui.panes()).find((p) => p.id === PANE)
  if (pane && pane.isPlaced) {
    await $.ui.close({ id: PANE })
    return {}
  }
  await refresh($)
  await $.ui.open({ id: PANE, title: paneTitle(), focus: true })
  return {}
}

function paneTitle() {
  return review ? 'Review · ' + (board && board.title ? board.title : review.slug) : 'Review'
}

async function reviewsRoot($) {
  try {
    const path = (await $.env.get('PR_REVIEW_BOARD_CONFIG')) || home + '/' + CONFIG_PATH
    if (await $.fs.exists(path)) {
      const root = JSON.parse(await $.fs.read(path)).reviews_root
      if (root) return root.startsWith('~/') ? home + root.slice(1) : root
    }
  } catch {
    // An unreadable config falls back to the harness default
  }
  return home + '/workspace/reviews'
}

/** A review the poller spawned: the one that recorded this session, else the one bound to this herdr workspace. */
async function spawnedReview($, root) {
  const path = (await $.env.get('PR_REVIEW_BOARD_STATE')) || home + '/' + STATE_PATH
  if (!(await $.fs.exists(path))) return undefined
  const state = JSON.parse(await $.fs.read(path))
  const reviews = state && state.reviews ? Object.entries(state.reviews) : []
  const active = reviews.filter(([, r]) => r && r.status === 'ACTIVE')
  const match =
    active.find(([, r]) => r.claude_session && r.claude_session === sessionId) ||
    (workspaceId ? active.find(([, r]) => r.herdr_workspace === workspaceId) : undefined)
  if (!match) return undefined
  const [key, r] = match
  return { key, slug: r.slug || key, prs: prsFromState(r), boardPath: root + '/.pr-review-board/' + key + '/board.json' }
}

/** A review run by hand through the review skill, which keys its board by this session's id. */
async function manualReview($, root) {
  const key = 'manual-' + sessionId
  const boardPath = root + '/.pr-review-board/' + key + '/board.json'
  if (!(await $.fs.exists(boardPath))) return undefined
  return { key, slug: key, prs: [], boardPath }
}

async function refresh($) {
  try {
    const root = await reviewsRoot($)
    const found = (await spawnedReview($, root)) || (await manualReview($, root))
    if (!found) {
      if (review || readError) {
        review = undefined
        board = undefined
        readError = undefined
        $.ui.invalidate('ui.render')
      }
      return
    }
    if (!review || review.key !== found.key) boardMtime = undefined
    review = found
    if (!(await $.fs.exists(review.boardPath))) {
      board = undefined
      readError = undefined
      $.ui.invalidate('ui.render')
      return
    }
    const stat = await $.fs.stat(review.boardPath)
    if (stat.mtimeMs === boardMtime) return
    // The worker may be mid-write; a parse failure leaves boardMtime unset so the next poll retries
    board = JSON.parse(await $.fs.read(review.boardPath))
    boardMtime = stat.mtimeMs
    readError = undefined
    // A comment that left `proposed` or `approved` cannot be posted again, so it stops counting as picked
    for (const c of Array.isArray(board.comments) ? board.comments : []) {
      if (!isPickable(c)) picks.delete(c.n)
    }
  } catch (err) {
    readError = 'Could not read the review board: ' + messageOf(err)
  }
  $.ui.invalidate('ui.render')
}

function prsFromState(r) {
  return (Array.isArray(r.prs) ? r.prs : []).map((pr) => {
    const [repo, number] = pr.split('#')
    return { pr, number: Number(number), url: 'https://github.com/' + repo + '/pull/' + number }
  })
}

/** A comment names its pull request as `owner/repo#N`, or by bare number in a single-repo review. */
function prOf(c, prs) {
  const found = prs.find((p) => (typeof c.pr === 'string' ? p.pr === c.pr : p.number === c.pr))
  const number = found ? found.number : typeof c.pr === 'string' ? Number(c.pr.split('#')[1]) : c.pr
  return { number, url: found && found.url ? found.url : undefined }
}

function severityOf(c) {
  return SEVERITIES.find((s) => s.id === c.severity) || SEVERITIES[SEVERITIES.length - 1]
}

function isPickable(c) {
  return !c.status || c.status === 'proposed' || c.status === 'approved'
}

function toggler($, id) {
  return async () => {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    $.ui.invalidate('ui.render')
  }
}

/** A hyperlink, drawn inside a Text so it can carry a color. */
function link(els, key, href, label, style = {}) {
  const { Text, Link } = els
  return Text({ key, ...style, children: [Link({ href, label })] })
}

/** A dim label in a fixed column, so the two sentences line up and read as one block. */
function labelled(els, key, label, sentence) {
  const { Box, Text } = els
  return Box({
    key,
    flexDirection: 'row',
    columnGap: 1,
    children: [Text({ dimColor: true, children: [label.padEnd(5)] }), Text({ wrap: 'wrap', children: [sentence] })],
  })
}

function summary(els, comments) {
  const { Box, Text } = els
  const proven = comments.filter((c) => c.confidence === 'proven').length
  const posted = comments.filter((c) => c.status === 'posted').length
  const head = [Text({ key: 'title', bold: true, children: [board.title || review.slug] })]
  if (board.verdict) {
    head.push(Text({ key: 'verdict', color: RISK_COLORS[board.verdict] || 'warning', children: [board.verdict] }))
  }
  const counts = [comments.length + ' comments', proven + ' proven']
  const fresh = comments.filter((c) => c.origin === 'new').length
  const carried = comments.filter((c) => c.origin === 'carried').length
  if (fresh || carried) counts.push(fresh + ' new', carried + ' carried over')
  counts.push(posted + ' posted')
  const lines = [
    Box({ key: 'title-row', flexDirection: 'row', columnGap: 1, children: head }),
    Text({ key: 'counts', dimColor: true, children: [counts.join(' · ')] }),
  ]
  const assessment = []
  if (board.risk) assessment.push(labelled(els, 'risk', 'Risk', board.risk))
  if (board.blast_radius) assessment.push(labelled(els, 'blast', 'Blast', board.blast_radius))
  if (assessment.length) lines.push(Box({ key: 'assessment', flexDirection: 'column', marginTop: 1, children: assessment }))
  return Box({ key: 'summary', flexDirection: 'column', paddingX: 1, children: lines })
}

function section(els, severity, comments, prs, $) {
  const { Box, Text } = els
  return Box({
    key: 'section-' + severity.id,
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: severity.color,
    paddingX: 1,
    children: [
      Box({
        key: 'heading-' + severity.id,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ bold: true, color: severity.color, children: [severity.title] }),
          Text({ dimColor: true, children: [String(comments.length)] }),
        ],
      }),
      ...comments.map((c) => commentRow(els, c, prs, $)),
    ],
  })
}

function commentRow(els, c, prs, $) {
  const { Box, Text, Button, Markdown } = els
  const pickable = isPickable(c)
  const picked = picks.has(c.n)
  const isOpen = expanded.has('c' + c.n)
  const toggle = async () => {
    if (picks.has(c.n)) picks.delete(c.n)
    else picks.add(c.n)
    $.ui.invalidate('ui.render')
  }
  const box = pickable
    ? Button({ key: 'pick-' + c.n, label: picked ? '[x]' : '[ ]', plain: true, dimColor: !picked, onPress: toggle })
    : Text({ dimColor: true, children: ['   '] })
  const { number, url } = prOf(c, prs)
  const head = [
    box,
    Button({ key: 'expand-' + c.n, label: isOpen ? '▾' : '▸', plain: true, dimColor: true, onPress: toggler($, 'c' + c.n) }),
    Text({ key: 'num-' + c.n, bold: true, children: [String(c.n).padStart(2)] }),
    url ? link(els, 'prlink-' + c.n, url, '#' + number) : Text({ key: 'prlink-' + c.n, dimColor: true, children: ['#' + number] }),
  ]
  if (c.confidence !== 'proven') head.push(Text({ key: 'conf-' + c.n, dimColor: true, children: ['?'] }))
  const origin = ORIGIN_TAGS[c.origin]
  if (origin) head.push(Text({ key: 'origin-' + c.n, color: origin.color, children: [origin.text] }))
  const tag = STATUS_TAGS[c.status]
  if (tag) head.push(Text({ key: 'status-' + c.n, color: tag.color, children: [tag.text] }))
  const quiet = c.status === 'dropped' || undefined
  const body = [Text({ key: 'summary-' + c.n, wrap: 'wrap', dimColor: quiet, children: [c.summary || c.target || ''] })]
  if (isOpen) {
    const full = []
    if (c.body) full.push(Text({ key: 'body-label-' + c.n, dimColor: true, children: ['Posts as'] }), Markdown({ key: 'body-md-' + c.n, text: c.body }))
    if (c.detail) full.push(Text({ key: 'detail-label-' + c.n, dimColor: true, children: ['Finding'] }), Markdown({ key: 'detail-md-' + c.n, text: c.detail }))
    if (c.origin_note) full.push(Text({ key: 'origin-label-' + c.n, dimColor: true, children: ['Origin'] }), Markdown({ key: 'origin-md-' + c.n, text: c.origin_note }))
    if (c.status_note) full.push(Text({ key: 'status-label-' + c.n, dimColor: true, children: ['Status'] }), Markdown({ key: 'status-md-' + c.n, text: c.status_note }))
    if (full.length) body.push(Box({ key: 'full-' + c.n, flexDirection: 'column', marginTop: 1, marginBottom: 1, children: full }))
  }
  const lines = [
    Box({ key: 'head-' + c.n, flexDirection: 'row', columnGap: 1, children: head }),
    Box({ key: 'body-' + c.n, flexDirection: 'column', paddingLeft: 6, children: body }),
  ]
  const files = fileLinksOf(els, c)
  if (files.length) {
    lines.push(Box({ key: 'files-' + c.n, flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, paddingLeft: 6, children: files }))
  }
  return Box({ key: 'comment-' + c.n, flexDirection: 'column', children: lines })
}

/** The comment's anchor first, then the code it cites, then the scratch tests that prove it, then the posted comment. */
function fileLinksOf(els, c) {
  const out = []
  const seen = new Set()
  const add = (href, label, style) => {
    if (!href || seen.has(href)) return
    seen.add(href)
    out.push(link(els, 'file-' + c.n + '-' + out.length, href, label, style))
  }
  add(c.location_url, c.target || 'code', { bold: true })
  for (const f of Array.isArray(c.files) ? c.files : []) {
    if (f && f.kind !== 'test') add(f.url, f.label || 'file', { dimColor: true })
  }
  for (const f of Array.isArray(c.files) ? c.files : []) {
    if (f && f.kind === 'test') add(f.url, 'test: ' + (f.label || 'scratch'), { color: 'suggestion' })
  }
  add(c.posted_url, 'posted comment', { color: 'success' })
  return out
}

/** The report's sections, one line each until opened, so the comments stay in view. */
function reportBox(els, sections, $) {
  const { Box, Text, Button, Markdown } = els
  const rows = []
  sections.forEach((s, i) => {
    const id = 'r:' + (s.id || i)
    const isOpen = expanded.has(id)
    rows.push(Button({ key: 'report-' + (s.id || i), label: (isOpen ? '▾ ' : '▸ ') + (s.title || 'Section'), plain: true, onPress: toggler($, id) }))
    if (isOpen && s.markdown) {
      rows.push(Box({ key: 'report-body-' + (s.id || i), paddingLeft: 2, marginBottom: 1, children: [Markdown({ key: 'report-md-' + (s.id || i), text: s.markdown })] }))
    }
  })
  return Box({
    key: 'report',
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'inactive',
    paddingX: 1,
    children: [
      Box({
        key: 'report-heading',
        flexDirection: 'row',
        columnGap: 1,
        children: [Text({ bold: true, children: ['Report'] }), Text({ dimColor: true, children: [String(sections.length)] })],
      }),
      ...rows,
    ],
  })
}

/** Comments already on GitHub, one quiet line each, kept below the ones still to decide. */
function postedSection(els, comments, prs) {
  const { Box, Text } = els
  const rows = comments.map((c) => {
    const { number, url } = prOf(c, prs)
    const parts = [
      Text({ key: 'posted-num-' + c.n, dimColor: true, children: [String(c.n).padStart(2)] }),
      url ? link(els, 'posted-pr-' + c.n, url, '#' + number, { dimColor: true }) : Text({ key: 'posted-pr-' + c.n, dimColor: true, children: ['#' + number] }),
    ]
    if (c.posted_url) parts.push(link(els, 'posted-link-' + c.n, c.posted_url, 'comment', { color: 'success' }))
    parts.push(Text({ key: 'posted-summary-' + c.n, dimColor: true, wrap: 'truncate-end', children: [c.summary || c.target || ''] }))
    return Box({ key: 'posted-' + c.n, flexDirection: 'row', columnGap: 1, children: parts })
  })
  return Box({
    key: 'section-posted',
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'inactive',
    paddingX: 1,
    children: [
      Box({
        key: 'heading-posted',
        flexDirection: 'row',
        columnGap: 1,
        children: [Text({ bold: true, color: 'success', children: ['Posted'] }), Text({ dimColor: true, children: [String(comments.length)] })],
      }),
      ...rows,
    ],
  })
}

/** Ticking comments only drafts the reply; the person still sends it, so approval stays theirs. */
function pickBar(els, $) {
  const { Box, Button } = els
  const picked = [...picks].sort((a, b) => a - b)
  if (!picked.length) return undefined
  const text = 'post ' + picked.join(', ')
  return Box({
    key: 'pick-bar',
    flexDirection: 'row',
    columnGap: 2,
    paddingX: 1,
    children: [
      Button({
        key: 'fill',
        label: 'Draft "' + text + '"',
        plain: true,
        onPress: async () => {
          const filled = await $.prompt.fill({ text })
          notice = filled && filled.isFilled === false ? 'The prompt box is busy; type: ' + text : undefined
          $.ui.invalidate('ui.render')
        },
      }),
      Button({
        key: 'clear-picks',
        label: 'clear',
        plain: true,
        dimColor: true,
        onPress: async () => {
          picks.clear()
          $.ui.invalidate('ui.render')
        },
      }),
    ],
  })
}

/**
 * The stacks the board names, each bottom layer first, then one stack per pull request the board puts in none. A board
 * that names no stacks is one stack holding every pull request, and draws no tabs.
 */
function stacksOf(prs) {
  const named = Array.isArray(board.stacks) ? board.stacks.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.prs)) : []
  if (!named.length) return [{ id: ALL_TABS, title: 'Stack', prs }]
  const byKey = new Map(prs.map((p) => [p.pr, p]))
  const placed = new Set()
  const stacks = named.map((s) => {
    const members = s.prs.map((key) => byKey.get(key)).filter(Boolean)
    for (const p of members) placed.add(p.pr)
    return { id: s.id, title: s.title || s.id, prs: members }
  })
  for (const p of prs) {
    if (!placed.has(p.pr)) stacks.push({ id: p.pr, title: '#' + p.number + (p.title ? ' ' + p.title : ''), prs: [p] })
  }
  return stacks
}

/** The id of the stack holding a comment's pull request; a comment on a pull request off the board belongs to none. */
function stackOf(c, prs, stacks) {
  const found = prs.find((p) => (typeof c.pr === 'string' ? p.pr === c.pr : p.number === c.pr))
  const stack = found && stacks.find((s) => s.prs.includes(found))
  return stack ? stack.id : undefined
}

function authorsOf(prs) {
  return [...new Set(prs.map((p) => p.author).filter(Boolean))]
}

/** One tab per stack beside All, each counting the comments still to decide on it. */
function tabBar(els, stacks, comments, prs, $) {
  const { Box, Button } = els
  const pending = comments.filter(isPickable).filter((c) => c.status !== 'dropped')
  const tabs = [{ id: ALL_TABS, title: 'All', count: pending.length }, ...stacks.map((s) => ({ ...s, count: pending.filter((c) => stackOf(c, prs, stacks) === s.id).length }))]
  return Box({
    key: 'tabs',
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 1,
    paddingX: 1,
    children: tabs.map((t) =>
      Button({
        key: 'tab-' + t.id,
        label: t.title + ' ' + t.count,
        variant: t.id === tab ? 'primary' : undefined,
        dimColor: t.id === tab ? undefined : true,
        onPress: async () => {
          tab = t.id
          $.ui.invalidate('ui.render')
        },
      }),
    ),
  })
}

/** A stack's name, how many pull requests it holds, and who wrote them. */
function stackHeading(els, key, title, count, authors) {
  const { Box, Text } = els
  const parts = [Text({ bold: true, children: [title] }), Text({ dimColor: true, children: [String(count)] })]
  if (authors.length) parts.push(Text({ dimColor: true, children: [authors.join(', ')] }))
  return Box({ key, flexDirection: 'row', columnGap: 1, children: parts })
}

/**
 * One quiet line per pull request: its number links it, a dot carries its risk, a short title says what it is. Its
 * author shows where a stack has more than one, and a layer based on something other than the row above names its base.
 */
function prRows(els, stack) {
  const { Box, Text } = els
  const several = authorsOf(stack.prs).length > 1
  return stack.prs.map((p, i) => {
    const below = i > 0 ? stack.prs[i - 1].pr : undefined
    const branch = p.base && p.base !== below ? p.base.split('#')[1] : undefined
    return Box({
      key: 'prrow-' + p.number,
      flexDirection: 'row',
      columnGap: 1,
      children: [
        link(els, 'pr-open-' + p.number, p.url, '#' + p.number),
        Text({ color: RISK_COLORS[p.risk] || 'inactive', children: ['●'] }),
        ...(several && p.author ? [Text({ dimColor: true, children: [p.author] })] : []),
        ...(branch ? [Text({ dimColor: true, children: ['on #' + branch] })] : []),
        ...(p.title ? [Text({ dimColor: true, wrap: 'truncate-end', children: [p.title] })] : []),
      ],
    })
  })
}

/** The pull requests in view: one stack under its own heading, or every stack under its own when All holds several. */
function prList(els, stacks, several) {
  const { Box, Text } = els
  const body = several
    ? [
        Box({
          key: 'prs-heading',
          flexDirection: 'row',
          columnGap: 1,
          children: [Text({ bold: true, children: ['Stacks'] }), Text({ dimColor: true, children: [String(stacks.length)] })],
        }),
        ...stacks.flatMap((s) => [stackHeading(els, 'stack-' + s.id, s.title, s.prs.length, authorsOf(s.prs)), ...prRows(els, s)]),
      ]
    : stacks.flatMap((s) => [stackHeading(els, 'prs-heading', s.title, s.prs.length, authorsOf(s.prs)), ...prRows(els, s)])
  return Box({ key: 'prs', flexDirection: 'column', borderStyle: 'round', borderColor: 'inactive', paddingX: 1, children: body })
}

function footer(Text, now) {
  if (notice) return Text({ key: 'footer', color: 'yellow', wrap: 'wrap', children: [notice] })
  const at = Date.parse(board.updated_at)
  const updated = Number.isNaN(at) ? '' : 'Updated ' + span(now - at) + ' ago.'
  return Text({ key: 'footer', dimColor: true, wrap: 'wrap', children: [updated] })
}

function messageOf(err) {
  return err && err.message ? err.message : String(err)
}

function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 60) return minutes + 'm'
  const hours = Math.round(minutes / 60)
  if (hours < 48) return hours + 'h'
  return Math.round(hours / 24) + 'd'
}
