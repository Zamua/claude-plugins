// Three tabs over the sessions' state files. PRs: every session's `prs`, one dense row each,
// projects in their `order`, a section per `group` inside each (ungrouped PRs first), workstreams
// whose PRs are all merged folded into Done, and stacks bracketed by their base branches or an
// entry's `stack_on`. PR Reviews: the reviews project's PRs the same way, a section per review
// session, marked by the person's own review. Asks: every open ask, by project, due soonest first;
// a row opens a dialog whose options send `[decision] <project>/<ask id>: <option>` to the root.
// props: { folder } (the projects folder), { reviews } (the project whose sessions review other
// people's PRs, default "reviews") and { block }, the layout block that shows it, left alone while
// hidden.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, InputState, Input } from "gpui-base";
import { exec, hc, theme, props, run, layout, watchFolder, openOverlay, closeOverlay, notify, settings, terminals, shared, setShared, readTextFile, writeTextFile } from "herdr";
import { folderOf, readFiles } from "./files.js";

const REFRESH_MS = 60000;
const FIELDS = "title url state isDraft reviewDecision mergeable baseRefName headRefName author{login ... on User{name}} " +
  "latestOpinionatedReviews(first:30){nodes{state author{login}}} latestReviews(first:30){nodes{state author{login}}} " +
  "commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}}";
const TABS = [["prs", "PRs"], ["reviews", "PR Reviews"], ["asks", "Asks"]];
// Decisions waiting for the root to be free, and the asks already answered from here, kept in
// shared state so the pane and its dialog see the same
const QUEUE = "session-prs.queue";
const SENT = "session-prs.sent";
// The PR tabs' filters by tab, then by dropdown: { prs: { author: [...], status: [...], stream: [...] } }
const FILTERS = "session-prs.filters";
const STATUSES = [["draft", "draft"], ["ready", "ready"], ["approved", "approved by me"], ["action", "needs action (!)"], ["ci", "CI failing"], ["merged", "merged"]];
const URL = /https?:\/\/[^\s)>"]+/g;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function parse(id) {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(id) ?? /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(id);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

// Projects in order, each PR with every session that lists it; a coordinator's entry wins over a
// worker's.
function projects(files) {
  const byName = new Map();
  const entries = [...files].sort(([, a], [, b]) => Number(b.title !== undefined) - Number(a.title !== undefined));
  for (const [key, f] of entries) {
    const [name, session] = key.split("/");
    const p = byName.get(name) ?? { name, title: name, order: Infinity, closed: false, prs: new Map() };
    if (f.title !== undefined) Object.assign(p, { title: f.title || name, order: f.order ?? Infinity, closed: Boolean(f.closed), lead: session });
    for (const x of f.prs ?? []) {
      const id = typeof x === "string" ? x : x?.pr;
      if (!id || !parse(id)) continue;
      const had = p.prs.get(id);
      if (had) had.sessions.push(session);
      else p.prs.set(id, { id, group: x?.group, on: x?.stack_on, sessions: [session], ...parse(id) });
    }
    byName.set(name, p);
  }
  return [...byName.values()]
    .filter((p) => !p.closed)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map((p) => ({ ...p, prs: [...p.prs.values()] }));
}

// Each PR once, under the first project that lists it.
function once(list) {
  const seen = new Set();
  return list.map((p) => ({ ...p, prs: p.prs.filter((pr) => !seen.has(pr.id) && seen.add(pr.id)) })).filter((p) => p.prs.length);
}

function openAsks(files) {
  const titles = new Map();
  for (const [key, f] of files) if (f.title !== undefined) titles.set(key.split("/")[0], { title: f.title || key.split("/")[0], order: f.order ?? Infinity });
  const asks = [];
  for (const [key, f] of files) {
    const [project, session] = key.split("/");
    for (const a of f.asks ?? []) if (a?.status === "open") asks.push({ ...a, project, session, key: `${key}#${a.id ?? asks.length}` });
  }
  const due = (a) => (a.due ? Date.parse(a.due) || Infinity : Infinity);
  const groups = new Map();
  for (const a of asks.sort((x, y) => due(x) - due(y))) {
    const g = groups.get(a.project) ?? { project: a.project, ...(titles.get(a.project) ?? { title: a.project, order: Infinity }), asks: [] };
    g.asks.push(a);
    groups.set(a.project, g);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

const optionText = (v) => (typeof v === "string" ? v : v?.label ?? v?.text ?? v?.option ?? JSON.stringify(v));

function rootTerminal() {
  return terminals().filter((t) => t.state === "live" && t.labels?.["tree.role"] === "root")
    .sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0))[0] ?? null;
}

// The root takes a decision only while it waits for input with nothing typed, so a draft of the
// person's is never added to or sent.
async function rootReady(t) {
  if (!t || t.status === "working" || t.status === "blocked") return false;
  const r = await hc(["read", t.address, "--json"]);
  const lines = JSON.parse(r.stdout || "{}").text?.split("\n") ?? [];
  const rules = lines.flatMap((l, i) => (l.startsWith("─".repeat(20)) ? [i] : []));
  if (rules.length < 2) return false;
  const typed = lines.slice(rules.at(-2) + 1, rules.at(-1)).map((l) => l.split("│")[0].replace(/\u00a0/g, " ").replace(/^❯/, "").trim());
  return typed.every((l) => l === "");
}

async function logDecision(folder, d, outcome) {
  const root = rootTerminal()?.labels?.["tree.project"] ?? "root";
  const path = `${folder}/${root}/decisions.jsonl`;
  const line = `${JSON.stringify({ at: new Date().toISOString(), project: d.project, ask: d.id, option: d.option, outcome })}\n`;
  for (let tries = 0; tries < 3; tries++) {
    const old = await readTextFile(path);
    try {
      return await writeTextFile(path, (old ?? "") + line, old);
    } catch {
      // Another write landed between the read and this one; read again
    }
  }
}

async function deliver(folder, d) {
  const t = rootTerminal();
  if (!(await rootReady(t))) return false;
  await hc(["send", t.address, d.line]);
  setShared(SENT, { ...(shared(SENT) ?? {}), [d.key]: Date.now() });
  await logDecision(folder, d, "sent");
  notify({ title: "Decision sent to root", body: d.line, level: "success", timeout: 4000 });
  return true;
}

const stackedOn = (on) => (typeof on === "number" ? on : Number(/#(\d+)$/.exec(String(on ?? ""))?.[1]) || null);

// Every PR row is this tall, so one row's rail meets the next row's
const ROW = 22;

// The stack bracket's piece for one row, drawn as borders so joined rows make one line.
function rail(t, kind) {
  const color = t.muted;
  return v_flex().w(16).h(ROW).flex_none().pl(4)
    .child(div().w(8).h(ROW / 2)
      .when(kind === "│" || kind === "└", (el) => el.border_l(1).border_color(color))
      .when(kind === "└", (el) => el.border_b(1).border_color(color).rounded_bl(3)))
    .child(div().w(8).h(ROW / 2)
      .when(kind === "│" || kind === "┌", (el) => el.border_l(1).border_color(color))
      .when(kind === "┌", (el) => el.border_t(1).border_color(color).rounded_tl(3)));
}

const isMerged = (pr) => pr?.state === "MERGED";
const isFinal = (pr) => pr?.state === "MERGED" || pr?.state === "CLOSED";
const firstName = (a) => (a?.name || a?.login || "").split(/\s+/)[0];

function age(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function dueLabel(due) {
  if (!due) return ["", null];
  const at = new Date(Date.parse(due));
  if (Number.isNaN(at.getTime())) return [String(due).slice(0, 10), null];
  const day = (d) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
  // A date with no time is the day it names, not UTC midnight the day before
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(due) ? Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) / 86400000) : day(at);
  const days = dated - day(new Date());
  if (days < 0) return [`${-days}d late`, "late"];
  if (days === 0) return ["today", "soon"];
  if (days === 1) return ["tomorrow", null];
  return [`${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`, null];
}

export default class SessionPrs extends View {
  init(_props, cx) {
    this.folder = folderOf(props());
    if (props()?.mode === "ask") return this.initAsk(cx);
    if (props()?.mode === "filter") return;
    this.reviewsProject = props()?.reviews ?? "reviews";
    this.files = new Map();
    this.live = new Map(JSON.parse(localStorage.getItem("live") ?? "[]"));
    this.viewer = localStorage.getItem("viewer");
    this.checked = new Set();
    this.doneOpen = new Set(JSON.parse(localStorage.getItem("doneOpen") ?? "[]"));
    this.tab = localStorage.getItem("tab") ?? "prs";
    cx.spawn(async (cx) => {
      this.files = await readFiles(this.folder);
      cx.notify();
      await this.refresh(cx, true);
      try {
        for (;;) {
          await watchFolder(this.folder);
          this.files = await readFiles(this.folder);
          cx.notify();
          await this.refresh(cx, false, true);
        }
      } catch {
        cx.timer.every(30000, (cx) => cx.spawn(async (cx) => {
          this.files = await readFiles(this.folder);
          cx.notify();
        }));
      }
    });
    cx.timer.every(REFRESH_MS, (cx) => cx.spawn(async (cx) => {
      await this.refresh(cx);
    }));
    cx.timer.every(3000, (cx) => cx.spawn(async () => {
      await this.drain();
    }));
  }

  // Queued decisions go out one at a time, oldest first, whenever the root is free.
  async drain() {
    const queue = shared(QUEUE) ?? [];
    if (!queue.length || this.draining) return;
    this.draining = true;
    try {
      if (await deliver(this.folder, queue[0])) setShared(QUEUE, (shared(QUEUE) ?? []).filter((d) => d.key !== queue[0].key));
    } finally {
      this.draining = false;
    }
  }

  initAsk(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.other = InputState.new({ placeholder: "Your answer" });
    this.other.on("submit", (_e, cx) => this.decide(this.other.value(), cx));
  }

  decide(option, cx) {
    const a = props().ask;
    const text = String(option ?? "").trim();
    if (!text) return;
    const d = { key: a.key, project: a.project, id: a.id ?? a.key, option: text, line: `[decision] ${a.project}/${a.id ?? a.key}: ${text}` };
    closeOverlay(props().overlay);
    cx.spawn(async () => {
      if (await deliver(this.folder, d)) return;
      setShared(QUEUE, [...(shared(QUEUE) ?? []).filter((q) => q.key !== d.key), d]);
      setShared(SENT, { ...(shared(SENT) ?? {}), [d.key]: Date.now() });
      await logDecision(this.folder, d, "queued");
      notify({ title: "Decision queued", body: "The root is busy or has a draft typed; it goes in once the prompt is free.", level: "info", timeout: 5000 });
    });
  }

  askDialog(t) {
    const a = props().ask;
    const [due] = dueLabel(a.due);
    const rec = String(a.recommend ?? a.recommendation ?? "").trim();
    const options = (Array.isArray(a.options) ? a.options : []).map(optionText);
    const isRec = (o) => rec && (o === rec || rec.startsWith(o) || o.startsWith(rec));
    const links = [...new Set(`${a.ask ?? ""} ${a.detail ?? ""} ${a.url ?? ""} ${(a.links ?? []).join(" ")}`.match(URL) ?? [])];
    const button = (id, label, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).hover((el) => el.opacity(0.88)).on_click(action).child(label);
    return v_flex().id("ask-dialog").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          closeOverlay(props().overlay);
          cx.stop_propagation();
        }
      })
      .w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().items_start().gap(10)
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(a.ask ?? a.id ?? ""))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(11.5).text_color(t.dim).child([a.project, a.session, due && `due ${due}`, a.created && `asked ${age(Date.parse(a.created))}`].filter(Boolean).join(" · ")))
      .when(Boolean(a.detail), (el) => el.child(div().id("ask-detail").max_h(260).overflow_y_scrollbar().text_size(12.5).line_height("19px").text_color(t.muted).child(a.detail)))
      .when(links.length > 0, (el) => el.child(v_flex().gap(2).children(links.map((u, k) => div().id(`ask-link-${k}`).truncate().text_size(12)
        .text_color(t.accent).cursor_pointer().hover((el) => el.underline()).on_click(() => exec("open", [u])).child(u)))))
      .child(v_flex().gap(6)
        .children(options.map((o, k) => h_flex().id(`ask-opt-${k}`).min_h(32).px(12).py(6).gap(8).items_center().rounded(7).cursor_pointer()
          .border_1().border_color(isRec(o) ? t.accent : t.input).bg(t.raised).hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => this.decide(o, cx))
          .child(div().flex_1().min_w(0).child(o))
          .when(isRec(o), (el) => el.child(div().flex_none().text_size(11).font_semibold().text_color(t.accent).child("Recommended")))))
        .when(Boolean(rec) && !options.some(isRec), (el) => el.child(div().text_size(12).text_color(t.muted).child(`Recommendation: ${rec}`)))
        .child(this.showOther
          ? h_flex().gap(8).items_center()
            .child(Input.new(this.other).flex_1().h(32).px(10).rounded(7).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
            .child(button("ask-other-send", "Send", true, (_e, cx) => this.decide(this.other.value(), cx)))
          : h_flex().id("ask-other").min_h(32).px(12).items_center().rounded(7).cursor_pointer().border_1().border_color(t.input)
            .text_color(t.muted).hover((el) => el.bg(t.hover))
            .on_click((_e, cx) => {
              this.showOther = true;
              this.other.focus();
              cx.notify();
            })
            .child("Other…")))
      .child(h_flex().gap(8).pt(4)
        .child(button("ask-open", "Open session", false, () => {
          closeOverlay(props().overlay);
          this.focusSession(a.project, a.session);
        }))
        .child(div().flex_1())
        .child(button("ask-cancel", "Cancel", false, () => closeOverlay(props().overlay))));
  }

  hidden() {
    const block = props()?.block;
    return Boolean(block && find(layout(), block)?.hidden);
  }

  // One GraphQL call for every PR that can still change; merged ones are asked once per pane start,
  // closed ones every time, since one may be reopened. `onlyNew`: just the PRs not asked yet, for a
  // state file that gained one.
  async refresh(cx, all = false, onlyNew = false) {
    if (this.busy || (this.hidden() && !all)) return;
    const prs = once(projects(this.files)).flatMap((p) => p.prs)
      .filter((p) => (onlyNew ? !this.checked.has(p.id) : all || !this.checked.has(p.id) || !isMerged(this.live.get(p.id))));
    if (!prs.length) return;
    this.busy = true;
    cx.notify();
    const query = `query{viewer{login} ${prs.map((p, i) => `p${i}:repository(owner:${JSON.stringify(p.owner)},name:${JSON.stringify(p.repo)}){pullRequest(number:${p.number}){${FIELDS}}}`).join(" ")}}`;
    try {
      const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]);
      const data = JSON.parse(r.stdout || "{}").data ?? {};
      if (data.viewer?.login) localStorage.setItem("viewer", (this.viewer = data.viewer.login));
      prs.forEach((p, i) => {
        const pr = data[`p${i}`]?.pullRequest;
        this.checked.add(p.id);
        if (!pr) return;
        const reviews = (nodes) => (nodes ?? []).map((n) => ({ login: n.author?.login, state: n.state }));
        this.live.set(p.id, {
          title: pr.title, url: pr.url, state: pr.state, draft: pr.isDraft, review: pr.reviewDecision, mergeable: pr.mergeable,
          base: pr.baseRefName, head: pr.headRefName, author: pr.author ? { login: pr.author.login, name: pr.author.name } : null,
          ci: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
          threads: (pr.reviewThreads?.nodes ?? []).filter((n) => !n.isResolved).length,
          reviews: reviews(pr.latestOpinionatedReviews?.nodes),
          latest: reviews(pr.latestReviews?.nodes),
        });
      });
      this.error = r.code === 0 || Object.keys(data).length ? null : (r.stderr.trim().split("\n")[0] || `gh exited ${r.code}`);
      this.at = Date.now();
      localStorage.setItem("live", JSON.stringify([...this.live]));
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    this.busy = false;
    cx.notify();
  }

  // A stream's PRs with each stack together, base first, and a bracket down the left of every
  // stack of two or more: ┌ its base, │ the middle, └ its top. A PR on no other PR has no bracket.
  runs(prs, heads) {
    const byNumber = new Map(prs.map((p) => [p.number, p]));
    const kids = new Map();
    const roots = [];
    for (const p of prs) {
      const on = this.onOf(p, heads);
      if (on && on !== p.number && byNumber.has(on)) kids.set(on, [...(kids.get(on) ?? []), p]);
      else roots.push(p);
    }
    const seen = new Set();
    const chain = (p) => {
      if (seen.has(p.id)) return [];
      seen.add(p.id);
      return [p, ...(kids.get(p.number) ?? []).flatMap(chain)];
    };
    // A stack looped back on itself has no root; its PRs still show, each on its own
    const stacks = [...roots, ...prs].map(chain).filter((run) => run.length);
    return stacks.flatMap((run) => run.map((p, k) => ({
      p,
      rail: run.length < 2 ? "" : k === 0 ? "┌" : k === run.length - 1 ? "└" : "│",
    })));
  }

  onOf(p, heads) {
    const pr = this.live.get(p.id);
    return stackedOn(p.on) ?? (pr?.base ? heads.get(`${p.owner}/${p.repo}:${pr.base}`) ?? null : null);
  }

  // ✓ and ! for a row. On someone else's PR the ✓ is the person's own approval and, on the Reviews
  // tab, ! is their review that stopped short of one; on their own PR the ✓ is anyone's approval.
  // Many repos compute no review decision, so the reviews themselves decide.
  marks(pr, reviewing) {
    if (!pr) return { approved: false, action: false };
    const mine = pr.author?.login === this.viewer;
    const approved = pr.review === "APPROVED" ||
      (pr.reviews ?? []).some((r) => r.state === "APPROVED" && (mine ? r.login !== this.viewer : r.login === this.viewer));
    const reviewed = (pr.latest ?? []).some((r) => r.login === this.viewer);
    const action = !isFinal(pr) && (pr.threads > 0 || (reviewing
      ? reviewed && !approved
      : pr.review === "CHANGES_REQUESTED" || pr.ci === "FAILURE" || pr.ci === "ERROR" || pr.mergeable === "CONFLICTING"));
    return { approved, action };
  }

  row(t, { p, rail: kind }, heads, who, reviewing) {
    const pr = this.live.get(p.id);
    const merged = isMerged(pr);
    const final = isFinal(pr);
    const { approved, action } = this.marks(pr, reviewing);
    const ci = final ? t.dim : { SUCCESS: t.ansi2, FAILURE: t.ansi1, ERROR: t.ansi1, PENDING: t.ansi3, EXPECTED: t.ansi3 }[pr?.ci] ?? t.dim;
    const [word, color] = !pr ? ["", t.dim] : merged ? ["merged", t.ansi5] : pr.state === "CLOSED" ? ["closed", t.ansi1] : pr.draft ? ["draft", t.muted] : ["ready", t.ansi4];
    const cell = (w, text, c) => div().w(w).flex_none().text_color(c).child(text);
    // Drawn inside a virtual list, where a row may register no handler; the list's on_item_click opens it
    return h_flex().id(`pr-${p.id}`).h(ROW).flex_none().px(12).items_center().whitespace_nowrap().cursor_pointer()
      .child(rail(t, kind))
      .child(cell(16, merged ? "◆" : approved ? "✓" : "", merged ? t.ansi5 : t.ansi2))
      .child(cell(14, action ? "!" : "", t.ansi3))
      .child(cell(54, `#${p.number}`, final ? t.dim : t.foreground))
      .child(h_flex().w(16).flex_none().child(div().size(8).rounded_full().bg(ci)
        .when(!final && pr?.ci === "PENDING", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1200 }))))
      .child(cell(56, word, color))
      .child(div().w(64).flex_none().mr(6).truncate().text_color(t.dim).child(who(pr?.author)))
      .child(div().flex_1().min_w(0).truncate().text_color(final ? t.dim : t.muted).child(pr?.title ?? p.id));
  }

  // The PRs and Reviews tabs: one flat list of same-height rows, so the visible range says which
  // headers to pin.
  prList(t, list, reviewing) {
    const heads = new Map();
    for (const proj of list) for (const p of proj.prs) {
      const pr = this.live.get(p.id);
      if (pr?.head) heads.set(`${p.owner}/${p.repo}:${pr.head}`, p.number);
    }
    const who = (author) => firstName(author).toLowerCase();
    const items = [];
    // A PR closed without merging is off the board until it is reopened
    const all = list
      .map((proj) => ({ ...proj, prs: proj.prs.filter((p) => this.live.get(p.id)?.state !== "CLOSED") }))
      .filter((proj) => proj.prs.length);

    // Filters: the values in one dropdown are ORed, the dropdowns ANDed, and an empty one is all
    const tab = reviewing ? "reviews" : "prs";
    const chosen = (shared(FILTERS) ?? {})[tab] ?? {};
    const pick = (dim) => chosen[dim] ?? [];
    const filtering = ["author", "status", "stream"].some((dim) => pick(dim).length);
    const statusOf = (p) => {
      const pr = this.live.get(p.id);
      const { approved, action } = this.marks(pr, reviewing);
      const open = pr && !isFinal(pr);
      return [open && pr.draft && "draft", open && !pr.draft && "ready", approved && "approved", action && "action",
        open && (pr.ci === "FAILURE" || pr.ci === "ERROR") && "ci", isMerged(pr) && "merged"].filter(Boolean);
    };
    const matches = (proj, p) => {
      const [authors, statuses, streams] = [pick("author"), pick("status"), pick("stream")];
      return (!authors.length || authors.includes(who(this.live.get(p.id)?.author))) &&
        (!statuses.length || statusOf(p).some((x) => statuses.includes(x))) &&
        (!streams.length || streams.includes(`${proj.name}/${p.group ?? ""}`));
    };
    const streams = all.flatMap((proj) => [...new Set(proj.prs.map((p) => p.group ?? ""))]
      .map((g) => ({ key: `${proj.name}/${g}`, name: g, project: proj.title })));
    const named = (name) => streams.filter((x) => x.name === name).length;
    const options = {
      author: [...new Set(all.flatMap((proj) => proj.prs.map((p) => who(this.live.get(p.id)?.author))).filter(Boolean))].sort().map((a) => ({ key: a, label: a })),
      status: STATUSES.map(([key, label]) => ({ key, label })),
      stream: streams.map((x) => ({ key: x.key, label: !x.name ? x.project : named(x.name) > 1 ? `${x.project} / ${x.name}` : x.name })),
    };
    const shown = filtering
      ? all.map((proj) => ({ ...proj, prs: proj.prs.filter((p) => matches(proj, p)) })).filter((proj) => proj.prs.length)
      : all;
    const bar = h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(11.5)
      .children([["author", "Author"], ["status", "Status"], ["stream", "Workstream"]].map(([dim, label]) => {
        const n = pick(dim).length;
        return h_flex().id(`flt-${tab}-${dim}`).h(22).px(8).gap(5).items_center().rounded(5).border_1()
          .border_color(n ? t.accent : t.input).text_color(n ? t.foreground : t.muted).cursor_pointer().hover((el) => el.bg(t.hover))
          .on_click(() => openOverlay({
            mod: "session-prs", kind: "popup", width: 280, height: Math.min(44 + options[dim].length * 26, 420),
            props: { mode: "filter", tab, dim, title: label, options: options[dim] },
          }))
          .child(n ? `${label} (${n})` : label)
          .child(div().text_color(t.dim).child("▾"));
      }))
      .when(filtering, (el) => el.child(div().id(`flt-${tab}-clear`).px(6).h(22).flex().items_center().text_color(t.dim).cursor_pointer()
        .hover((el) => el.text_color(t.foreground))
        .on_click(() => setShared(FILTERS, { ...(shared(FILTERS) ?? {}), [tab]: {} }))
        .child("clear all")));
    const finished = (g) => g.prs.every((p) => isMerged(this.live.get(p.id)));
    const groupsOf = (proj) => {
      const groups = [];
      for (const p of proj.prs) {
        const title = p.group ?? "";
        let g = groups.find((g) => g.title === title);
        if (!g) (title ? groups.push((g = { title, prs: [] })) : groups.unshift((g = { title, prs: [] })));
        g.prs.push(p);
      }
      return groups;
    };
    const emitProject = (proj, first, top) => {
      if (!first) items.push({ kind: "gap", top });
      const project = items.length;
      items.push({ kind: "project", title: proj.title, project, top, open: proj.lead ? `${proj.name}/${proj.lead}` : null });
      const groups = groupsOf(proj);
      const emit = (g, gap, done, title = g.title) => {
        if (gap && title) items.push({ kind: "gap", project, done, top });
        const group = title ? items.length : null;
        if (title) items.push({ kind: "group", title, project, group, done, top, open: reviewing && g.title ? `${proj.name}/${g.title}` : null });
        for (const n of this.runs(g.prs, heads)) items.push({ kind: "pr", n, project, group, done, top });
      };
      // A workstream whose PRs are all merged waits, folded, in Done at the project's foot; the
      // ungrouped PRs count as one, named for the project there
      groups.filter((g) => !finished(g)).forEach((g, j) => emit(g, j > 0));
      const done = groups.filter(finished);
      if (!done.length) return;
      if (items.length - 1 > project) items.push({ kind: "gap", project, top });
      const at = items.length;
      const key = `${reviewing ? "r" : "p"}:${proj.name}`;
      // A filter's matches stay in view even when they are all merged
      const open = filtering || this.doneOpen.has(key);
      items.push({ kind: "done", title: `Done · ${done.length} workstream${done.length === 1 ? "" : "s"}`, name: key, open, project, done: at, top });
      if (open) done.forEach((g, j) => emit(g, j > 0, at, g.title || proj.title));
    };
    // A project with every workstream done moves, folded, into one Done at the foot of the tab
    const allDone = (proj) => groupsOf(proj).every(finished);
    const active = shown.filter((proj) => !allDone(proj));
    const resting = shown.filter(allDone);
    active.forEach((proj, i) => emitProject(proj, i === 0));
    if (resting.length) {
      if (items.length) items.push({ kind: "gap" });
      const top = items.length;
      const key = `${reviewing ? "r" : "p"}:*`;
      // A filter's matches stay in view even when they are all merged
      const open = filtering || this.doneOpen.has(key);
      items.push({ kind: "done", title: `Done · ${resting.length} project${resting.length === 1 ? "" : "s"}`, name: key, open, top, done: top, project: top });
      if (open) resting.forEach((proj) => emitProject(proj, false, top));
    }

    // A header that belongs to a session ends in a terminal icon; the header opens that session
    const go = (item) => (item.open ? (el) => el.cursor_pointer().child(div().flex_1())
      .child(svg("mods/session-prs/terminal.svg").size(12).flex_none().text_color(t.dim)) : (el) => el);
    const header = (item) => item.kind === "project"
      ? go(item)(h_flex().h(ROW).px(12).items_center().border_b(1).border_color(t.border).bg(t.surface)
        .child(div().font_bold().text_color(t.foreground).child(item.title)))
      : item.kind === "done"
        ? h_flex().h(ROW).px(12).gap(6).items_center().whitespace_nowrap().bg(t.surface).cursor_pointer().text_color(t.dim)
          .child(div().w(10).child(item.open ? "▾" : "▸")).child(div().child(item.title))
        : go(item)(h_flex().h(ROW).px(12).items_center().whitespace_nowrap().bg(t.surface)
          .child(div().font_semibold().text_color(t.foreground).child(item.title)));
    const openSession = (path) => this.focusSession(...path.split("/"));
    const toggleDone = (name, cx) => {
      this.doneOpen.has(name) ? this.doneOpen.delete(name) : this.doneOpen.add(name);
      localStorage.setItem("doneOpen", JSON.stringify([...this.doneOpen]));
      cx.notify();
    };
    const draw = (item) => (item.kind === "pr" ? this.row(t, item.n, heads, who, reviewing) : item.kind === "gap" ? div().h(ROW) : header(item));
    const keyOf = (k) => {
      const item = items[k];
      if (item?.kind === "pr") return item.n.p.id;
      if (item?.kind === "done") return `done:${item.name}`;
      return item?.open && item.kind !== "done" ? `open:${k}:${item.open}` : `row-${k}`;
    };
    const at = this.top ?? 0;
    const top = items[at];
    const pin = (k) => (k != null && at >= k ? [items[k]] : []);
    const pinned = !top ? [] : [...new Set([
      ...(top.top != null && at > top.top ? [items[top.top]] : []),
      ...(top.project != null && at > top.project ? [items[top.project]] : []),
      ...(top.project != null && at > top.project ? pin(top.done) : []),
      ...(top.project != null && at > top.project ? pin(top.group) : []),
    ])];
    const empty = filtering ? "No pull request matches these filters." : reviewing ? "No review session lists a pull request." : "No session lists a pull request yet.";
    if (!items.length) return v_flex().flex_1().min_h(0).child(bar).child(div().px(12).py(8).text_color(t.dim).child(empty));
    const id = reviewing ? "rv-list" : "pr-list";
    return v_flex().flex_1().min_h(0).w_full().child(bar).child(div().id(`${id}-body`).flex_1().min_h(0).w_full().relative()
      // The list reports its first visible row as it draws; a wheel turn redraws the pinned headers from it
      .on_scroll_wheel((_e, cx) => cx.notify())
      .child(v_virtual_list(id, items.length, ROW, keyOf, (range) => {
        this.top = range.start;
        return items.slice(range.start, range.end).map(draw);
      }).size_full().on_item_click((key, cx) => {
        if (key.startsWith("done:")) return toggleDone(key.slice(5), cx);
        if (key.startsWith("open:")) return openSession(key.split(":").slice(2).join(":"));
        const p = items.find((item) => item.kind === "pr" && item.n.p.id === key)?.n.p;
        if (p) exec("open", [this.live.get(p.id)?.url ?? `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`]);
      }))
      .when(pinned.length > 0, (el) => el.child(v_flex().absolute().top(0).left(0).right(0).children(pinned.map((item, k) =>
        item.kind === "done" ? div().id(`pin-${k}`).on_click((_e, cx) => toggleDone(item.name, cx)).child(header(item))
          : item.open ? div().id(`pin-${k}`).on_click(() => openSession(item.open)).child(header(item)) : header(item)))))
      .child(Scrollbar.vertical(id).absolute().inset_0()));
  }

  filterPopup(t) {
    const { tab, dim, title, options } = props();
    const all = shared(FILTERS) ?? {};
    const chosen = all[tab]?.[dim] ?? [];
    const set = (next) => setShared(FILTERS, { ...all, [tab]: { ...(all[tab] ?? {}), [dim]: next } });
    return v_flex().size_full().min_h(0).p(6).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().px(8).pt(4).pb(6).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(title))
        .when(chosen.length > 0, (el) => el.child(div().id("flt-none").text_size(11).text_color(t.dim).cursor_pointer()
          .hover((el) => el.text_color(t.foreground)).on_click(() => set([])).child("clear"))))
      .child(v_flex().id("flt-list").flex_1().min_h(0).overflow_y_scrollbar().children(options.map((o, k) => {
        const on = chosen.includes(o.key);
        return h_flex().id(`flt-o-${k}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((el) => el.bg(t.hover))
          .on_click(() => set(on ? chosen.filter((x) => x !== o.key) : [...chosen, o.key]))
          .child(div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.popover)
            .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(on ? "✓" : ""))
          .child(div().flex_1().min_w(0).truncate().child(o.label));
      })));
  }

  focusSession(project, session) {
    const live = terminals().filter((t) => t.state === "live" && t.labels?.["tree.project"] === project);
    const t = live.find((t) => t.name === session) ?? (session === project ? live.find((t) => t.labels?.["tree.role"] !== "worker") : null);
    if (t) run("pane.focus", { terminal: t.address });
  }

  askList(t, groups) {
    if (!groups.length) return div().px(12).py(8).text_color(t.dim).child("Nothing waits on you.");
    const sent = shared(SENT) ?? {};
    const rows = groups.flatMap((g, i) => [
      h_flex().h(ROW).px(12).mt(i ? 10 : 2).items_center().border_b(1).border_color(t.border)
        .child(div().font_bold().text_color(t.foreground).child(g.title)),
      ...g.asks.map((a) => {
        const [due, tone] = dueLabel(a.due);
        const isSent = Boolean(sent[a.key]);
        return h_flex().id(`ask-${a.key}`).h(ROW).px(12).gap(8).items_center().whitespace_nowrap().rounded(5).cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click(() => openOverlay({ mod: "session-prs", kind: "dialog", width: 640, props: { mode: "ask", ask: a, folder: props()?.folder } }))
          .child(div().w(70).flex_none().text_color(isSent ? t.dim : tone === "late" ? t.blocked : tone === "soon" ? t.ansi3 : t.dim).child(isSent ? "sent" : due))
          .child(div().flex_1().min_w(0).truncate().text_color(isSent ? t.dim : t.foreground).child(a.ask ?? a.id ?? ""))
          .child(div().id(`ask-s-${a.key}`).w(96).flex_none().truncate().text_color(t.dim).cursor_pointer()
            .hover((el) => el.text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.focusSession(a.project, a.session);
            })
            .child(a.session));
      }),
    ]);
    return v_flex().id("ask-list").flex_1().min_h(0).py(4).overflow_y_scrollbar().children(rows);
  }

  render() {
    const t = theme();
    if (props()?.mode === "ask") return this.askDialog(t);
    if (props()?.mode === "filter") return this.filterPopup(t);
    const all = projects(this.files);
    const asks = openAsks(this.files);
    const count = asks.reduce((n, g) => n + g.asks.length, 0);
    const close = () => {
      const block = props()?.block;
      if (block && find(layout(), block)) run("layout.hide", { id: block });
      else if (props()?.overlay) closeOverlay(props().overlay);
    };
    const pick = (tab, cx) => {
      this.tab = tab;
      this.top = 0;
      localStorage.setItem("tab", tab);
      cx.notify();
    };
    const reviews = all.filter((p) => p.name === this.reviewsProject).map((p) => ({
      ...p,
      prs: p.prs.map((pr) => ({ ...pr, group: pr.sessions.find((s) => s !== p.name) ?? pr.group ?? p.title })),
    }));
    const body = this.tab === "asks" ? this.askList(t, asks)
      : this.tab === "reviews" ? this.prList(t, once(reviews), true)
        : this.prList(t, once(all.filter((p) => p.name !== this.reviewsProject)), false);
    const status = this.tab === "asks" ? "" : this.error ?? (this.at ? `GitHub checked ${age(this.at)}` : this.busy ? "checking GitHub…" : "");
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .child(h_flex().h(34).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .children(TABS.map(([id, label]) => h_flex().id(`tab-${id}`).h(24).px(8).gap(5).items_center().rounded(5).cursor_pointer()
          .when(this.tab === id, (el) => el.bg(t.raised).text_color(t.foreground))
          .when(this.tab !== id, (el) => el.text_color(t.dim).hover((el) => el.text_color(t.foreground)))
          .on_click((_e, cx) => pick(id, cx))
          .child(label)
          .when(id === "asks" && count > 0, (el) => el.child(div().px(5).h(15).flex().items_center().rounded_full().bg(t.blocked)
            .text_size(10).font_bold().text_color(t.background).child(String(count))))))
        .child(div().flex_1().min_w(0).ml(6).truncate().text_size(11).text_color(this.error ? t.blocked : t.dim).child(status))
        .when(this.tab !== "asks", (el) => el.child(div().id("pr-refresh").px(6).h(22).flex().items_center().rounded(5).text_color(t.muted).cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => cx.spawn(async (cx) => {
            await this.refresh(cx, true);
          })).child("refresh")))
        .child(div().id("pr-close").px(6).h(22).flex().items_center().rounded(5).text_color(t.muted).cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click(close).child("×")))
      .child(body);
  }
}
