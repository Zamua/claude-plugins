// Three tabs over the sessions' state files. PRs: every session's `prs`, one dense row each,
// projects in their `order`, a section per `group` inside each (ungrouped PRs first), workstreams
// whose PRs are all merged folded into Done, and stacks bracketed by their base branches or an
// entry's `stack_on`. PR Reviews: the reviews project's PRs the same way, a section per review
// session, marked by the person's own review. Asks: every open ask, by project, due soonest first.
// props: { folder } (the projects folder), { reviews } (the project whose sessions review other
// people's PRs, default "reviews") and { block }, the layout block that shows it, left alone while
// hidden.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { exec, theme, props, run, layout, watchFolder, closeOverlay, settings, terminals } from "herdr";
import { folderOf, readFiles } from "./files.js";

const REFRESH_MS = 60000;
const FIELDS = "title url state isDraft reviewDecision mergeable baseRefName headRefName author{login ... on User{name}} " +
  "latestOpinionatedReviews(first:30){nodes{state author{login}}} latestReviews(first:30){nodes{state author{login}}} " +
  "commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}}";
const TABS = [["prs", "PRs"], ["reviews", "PR Reviews"], ["asks", "Asks"]];

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
    this.reviewsProject = props()?.reviews ?? "reviews";
    this.files = new Map();
    this.live = new Map(JSON.parse(localStorage.getItem("live") ?? "[]"));
    this.viewer = localStorage.getItem("viewer");
    this.checked = new Set();
    this.doneOpen = new Set(JSON.parse(localStorage.getItem("doneOpen") ?? "[]"));
    this.tab = localStorage.getItem("tab") ?? "prs";
    this.expanded = new Set();
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
    const shown = list
      .map((proj) => ({ ...proj, prs: proj.prs.filter((p) => this.live.get(p.id)?.state !== "CLOSED") }))
      .filter((proj) => proj.prs.length);
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
      const open = this.doneOpen.has(key);
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
      const open = this.doneOpen.has(key);
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
    if (!items.length) return div().px(12).py(8).text_color(t.dim).child(reviewing ? "No review session lists a pull request." : "No session lists a pull request yet.");
    const id = reviewing ? "rv-list" : "pr-list";
    return div().id(`${id}-body`).flex_1().min_h(0).w_full().relative()
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
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  focusSession(project, session) {
    const live = terminals().filter((t) => t.state === "live" && t.labels?.["tree.project"] === project);
    const t = live.find((t) => t.name === session) ?? (session === project ? live.find((t) => t.labels?.["tree.role"] !== "worker") : null);
    if (t) run("pane.focus", { terminal: t.address });
  }

  askList(t, groups) {
    if (!groups.length) return div().px(12).py(8).text_color(t.dim).child("Nothing waits on you.");
    const urls = (a) => [...new Set(`${a.ask ?? ""} ${a.detail ?? ""} ${a.url ?? ""} ${(a.links ?? []).join(" ")}`.match(/https?:\/\/[^\s)>"]+/g) ?? [])];
    const text = (v) => (typeof v === "string" ? v : v?.label ?? v?.text ?? v?.option ?? JSON.stringify(v));
    const rows = groups.flatMap((g, i) => [
      h_flex().h(ROW).px(12).mt(i ? 10 : 2).items_center().border_b(1).border_color(t.border)
        .child(div().font_bold().text_color(t.foreground).child(g.title)),
      ...g.asks.flatMap((a) => {
        const [due, tone] = dueLabel(a.due);
        const open = this.expanded.has(a.key);
        const detail = v_flex().pl(108).pr(12).pb(6).gap(3).text_size(11.5).text_color(t.muted)
          .when(Boolean(a.detail), (el) => el.child(div().child(a.detail)))
          .when(Array.isArray(a.options) && a.options.length > 0, (el) => el.children(a.options.map((o) => div().child(`• ${text(o)}`))))
          .when(Boolean(a.recommend ?? a.recommendation), (el) => el.child(div().text_color(t.foreground).child(`Recommend: ${text(a.recommend ?? a.recommendation)}`)))
          .children(urls(a).map((u, k) => div().id(`ask-u-${a.key}-${k}`).truncate().text_color(t.accent).cursor_pointer()
            .hover((el) => el.underline()).on_click((_e, cx) => {
              cx.stop_propagation();
              exec("open", [u]);
            }).child(u)));
        return [
          h_flex().id(`ask-${a.key}`).h(ROW).px(12).gap(8).items_center().whitespace_nowrap().rounded(5).cursor_pointer()
            .hover((el) => el.bg(t.hover))
            .on_click((_e, cx) => {
              open ? this.expanded.delete(a.key) : this.expanded.add(a.key);
              cx.notify();
            })
            .child(div().w(10).flex_none().text_color(t.dim).child(open ? "▾" : "▸"))
            .child(div().w(70).flex_none().text_color(tone === "late" ? t.blocked : tone === "soon" ? t.ansi3 : t.dim).child(due))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.ask ?? a.id ?? ""))
            .child(div().id(`ask-s-${a.key}`).w(96).flex_none().truncate().text_color(t.dim).cursor_pointer()
              .hover((el) => el.text_color(t.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.focusSession(a.project, a.session);
              })
              .child(a.session)),
          ...(open ? [detail] : []),
        ];
      }),
    ]);
    return v_flex().id("ask-list").flex_1().min_h(0).py(4).overflow_y_scrollbar().children(rows);
  }

  render() {
    const t = theme();
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
