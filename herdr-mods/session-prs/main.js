// Tabs over the sessions' state files, then a tab per tracker file (see tracker.js). PRs: every
// session's `prs`, one dense row each, its title opening a card with the full title and the summary from its
// description (see summary.js), projects in their `order`, a section per `group` inside each (ungrouped PRs first), workstreams
// whose PRs are all merged folded into Done, and stacks bracketed by their base branches or an
// entry's `stack_on`. PR Reviews: the reviews project's PRs the same way, a section per review
// session, marked by the person's own review. Asks: every open ask, by project, due soonest first;
// a row opens a dialog that numbers its options, so the person can name one in chat ("A25 option 2"), or,
// when `channel` in the config names the asks broker's command and the ask's session has a live channel,
// press one to send it to that session.
// Each ask keeps the short id, A1 and up, it was first given, in <root project>/ask-ids.json.
// With `authored: { owners: [..] }` in ~/.config/herdr-app/session-prs.json, every open PR the
// person authored under those owners is listed too, from GitHub's search. A PR no session lists
// goes where the root's pr-groups.json places it, else under Untracked at the top of the PRs tab.
// props: { folder } (the projects folder), { reviews } (the project whose sessions review other
// people's PRs, default "reviews") and { block }, the layout block that shows it, left alone while
// hidden.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, HoverCard } from "gpui-base";
import { exec, theme, props, run, layout, watchFolder, openOverlay, closeOverlay, settings, terminals, shared, setShared, readTextFile, writeTextFile, home } from "herdr";
import { folderOf, readFiles, readConfig } from "./files.js";
import { readTrackers, trackerTitle, gapCount, trackerBody, trackerDialog } from "./tracker.js";
import { summaryOf } from "./summary.js";

const REFRESH_MS = 60000;
const FIELDS = "title body url state isDraft reviewDecision mergeable baseRefName headRefName author{login ... on User{name}} " +
  "latestOpinionatedReviews(first:30){nodes{state author{login}}} latestReviews(first:30){nodes{state author{login}}} " +
  "commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}}";
const TABS = [["prs", "PRs"], ["reviews", "PR Reviews"], ["asks", "Asks"]];
// The PR tabs' filters by tab, then by dropdown: { prs: { author: [...], status: [...], stream: [...] } }
const FILTERS = "session-prs.filters";
// Which filter dropdown is open, and when it last closed: a press on its own button closes it, and
// the press that closes it from outside arrives a moment after the popup has already gone
const DROPDOWN = "session-prs.dropdown";
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
    for (const x of Array.isArray(f.prs) ? f.prs : []) {
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

// Adds the PRs no session lists. Those placed in the root's pr-groups.json go under the project
// or workstream it names; the person's own open PRs placed nowhere go under Untracked, first.
function placed(all, entries, authored) {
  const key = (p) => `${p.owner}/${p.repo}#${p.number}`.toLowerCase();
  const listed = new Set(all.flatMap((proj) => proj.prs.map(key)));
  const out = all.map((proj) => ({ ...proj, prs: [...proj.prs] }));
  const byName = new Map(out.map((proj) => [proj.name, proj]));
  const streams = new Map();
  for (const [ref, to] of Object.entries(entries ?? {})) {
    const p = parse(ref);
    if (!p || !to || listed.has(key(p))) continue;
    listed.add(key(p));
    const pr = { id: `${p.owner}/${p.repo}#${p.number}`, ...p, group: to.group, sessions: [] };
    const proj = to.project && byName.get(to.project);
    if (proj) {
      proj.prs.push(pr);
      continue;
    }
    const name = to.workstream ?? to.project;
    if (!name) continue;
    if (!streams.has(name)) streams.set(name, { name: `~ws:${name}`, title: name, order: Infinity, closed: false, prs: [] });
    streams.get(name).prs.push(pr);
  }
  const loose = [...authored.values()].filter((p) => !listed.has(key(p))).map((p) => ({ ...p, sessions: [] }));
  return [...(loose.length ? [{ name: "~untracked", title: "Untracked", order: -Infinity, closed: false, prs: loose }] : []), ...out, ...streams.values()];
}

// Each PR once, under the first project that lists it.
function once(list) {
  const seen = new Set();
  return list.map((p) => ({ ...p, prs: p.prs.filter((pr) => !seen.has(pr.id) && seen.add(pr.id)) })).filter((p) => p.prs.length);
}

const dueAt = (a) => (a.due ? Date.parse(a.due) || Infinity : Infinity);
const askRef = (a) => `${a.project}/${a.id ?? a.key}`;

function openAsks(files) {
  const titles = new Map();
  for (const [key, f] of files) if (f.title !== undefined) titles.set(key.split("/")[0], { title: f.title || key.split("/")[0], order: f.order ?? Infinity });
  const asks = [];
  for (const [key, f] of files) {
    const [project, session] = key.split("/");
    for (const a of f.asks ?? []) if (a?.status === "open") asks.push({ ...a, project, session, key: `${key}#${a.id ?? asks.length}` });
  }
  const groups = new Map();
  for (const a of asks.sort((x, y) => dueAt(x) - dueAt(y))) {
    const g = groups.get(a.project) ?? { project: a.project, ...(titles.get(a.project) ?? { title: a.project, order: Infinity }), asks: [] };
    g.asks.push(a);
    groups.set(a.project, g);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

// The command that reaches the asks broker, from `channel` in this mod's config: a path or an argv.
// It is used only when the ask's own session has a live channel, so every other ask is answered in chat.
async function channelFor(a) {
  const raw = (await readConfig()).channel;
  const argv = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => (typeof x === "string" && x.startsWith("~") ? home() + x.slice(1) : x));
  if (!argv.length || !a?.id || !a.session) return null;
  try {
    const r = await exec(argv[0], [...argv.slice(1), "sessions"]);
    const live = JSON.parse(r.stdout || "{}").sessions ?? [];
    return live.some((s) => s.project === a.project && s.name === a.session) ? argv : null;
  } catch {
    return null;
  }
}

const optionText = (v) => (typeof v === "string" ? v : v?.label ?? v?.text ?? v?.option ?? JSON.stringify(v));

function rootTerminal() {
  return terminals().filter((t) => t.state === "live" && t.labels?.["tree.role"] === "root")
    .sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0))[0] ?? null;
}

const rootFile = (folder, name) => `${folder}/${rootTerminal()?.labels?.["tree.project"] ?? "root"}/${name}`;

// Gives every open ask not seen before the next short id, soonest due first, and returns the whole
// map. An id is never reused or moved, so a file that does not parse is left alone, not restarted.
async function askIds(folder, asks) {
  const path = rootFile(folder, "ask-ids.json");
  for (let tries = 0; tries < 3; tries++) {
    const old = await readTextFile(path).catch(() => null);
    let map = { next: 1, ids: {} };
    if (old) {
      try {
        map = JSON.parse(old);
      } catch {
        return {};
      }
    }
    const fresh = [...asks].sort((x, y) => dueAt(x) - dueAt(y)).map(askRef).filter((r) => !map.ids[r]);
    if (!fresh.length) return map.ids;
    for (const r of fresh) map.ids[r] = `A${map.next++}`;
    try {
      await writeTextFile(path, `${JSON.stringify(map, null, 2)}\n`, old);
      return map.ids;
    } catch {
      // Another copy wrote first; read its ids again
    }
  }
  return {};
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
    if (props()?.mode === "ask" || props()?.mode === "tracker-item") return this.initAsk(cx);
    if (props()?.mode === "filter") return;
    this.reviewsProject = props()?.reviews ?? "reviews";
    this.files = new Map();
    this.live = new Map(JSON.parse(localStorage.getItem("live") ?? "[]"));
    this.viewer = localStorage.getItem("viewer");
    this.checked = new Set();
    this.doneOpen = new Set(JSON.parse(localStorage.getItem("doneOpen") ?? "[]"));
    this.tab = localStorage.getItem("tab") ?? "prs";
    this.ids = {};
    this.config = {};
    this.authored = new Map(JSON.parse(localStorage.getItem("authored") ?? "[]"));
    this.trackers = [];
    this.trackerOpen = JSON.parse(localStorage.getItem("trackerOpen") ?? "{}");
    cx.spawn(async (cx) => {
      await this.loadTrackers(cx);
      const dirs = [...new Set(this.trackers.map((tr) => tr.dir))];
      if (!dirs.length) return;
      try {
        for (;;) {
          await Promise.race(dirs.map((d) => watchFolder(d)));
          await this.loadTrackers(cx);
        }
      } catch {
        cx.timer.every(30000, (cx) => cx.spawn(async (cx) => {
          await this.loadTrackers(cx);
        }));
      }
    });
    const load = async () => {
      this.files = await readFiles(this.folder);
      this.ids = await askIds(this.folder, openAsks(this.files).flatMap((g) => g.asks));
    };
    cx.spawn(async (cx) => {
      this.config = await readConfig();
      await load();
      cx.notify();
      await this.refresh(cx, true);
      try {
        for (;;) {
          await watchFolder(this.folder);
          await load();
          cx.notify();
          await this.refresh(cx, false, true);
        }
      } catch {
        cx.timer.every(30000, (cx) => cx.spawn(async (cx) => {
          await load();
          cx.notify();
        }));
      }
    });
    cx.timer.every(REFRESH_MS, (cx) => cx.spawn(async (cx) => {
      await this.refresh(cx);
    }));
  }

  // { "<owner>/<repo>#<n>": { project, group } or { workstream } }, kept by the root
  prGroups() {
    return this.files.get(`${rootTerminal()?.labels?.["tree.project"] ?? "root"}/pr-groups`)?.groups ?? {};
  }

  async loadTrackers(cx) {
    this.config = await readConfig();
    this.trackers = await readTrackers(this.config);
    cx.notify();
  }

  initAsk(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (props()?.mode !== "ask") return;
    this.channel = null;
    this.sent = null;
    cx.spawn(async (cx) => {
      this.channel = await channelFor(props().ask);
      cx.notify();
    });
  }

  // An option pressed in the dialog goes to the session that asked, through the channel's broker
  choose(a, option) {
    return (_e, cx) => cx.spawn(async (cx) => {
      if (this.sent?.state === "sending" || this.sent?.state === "sent") return;
      this.sent = { option, state: "sending" };
      cx.notify();
      const [cmd, ...args] = this.channel;
      const r = await exec(cmd, [...args, "decide", `${a.project}/${a.session}`, a.id, option, ...(a.short ? ["--a-id", a.short] : [])]);
      let res = {};
      try {
        res = JSON.parse(r.stdout || "{}");
      } catch {
        res = {};
      }
      this.sent = res.ok ? { option, state: "sent", to: res.delivered ?? [] }
        : { option, state: "failed", error: res.error || r.stderr?.trim().split("\n")[0] || `exited ${r.code}` };
      cx.notify();
    });
  }

  askDialog(t) {
    const a = props().ask;
    const [due] = dueLabel(a.due);
    const rec = String(a.recommend ?? a.recommendation ?? "").trim();
    const options = (Array.isArray(a.options) ? a.options : []).map(optionText);
    const nth = Number(/^option\s*(\d+)\b/i.exec(rec)?.[1]);
    const isRec = (o, k) => (nth ? k === nth - 1 : rec && (o === rec || rec.startsWith(o) || o.startsWith(rec)));
    // An ask's links are URLs or { label, url }; a labelled one stands for the same URL in the text
    const links = [];
    const add = (url, label) => {
      if (url && !links.some((l) => l.url === url)) links.push({ url, label: label || url });
    };
    for (const l of [].concat(a.links ?? [])) {
      if (typeof l === "string") (l.match(URL) ?? []).forEach((u) => add(u));
      else if (typeof l?.url === "string") add(l.url, typeof l.label === "string" ? l.label : null);
    }
    for (const u of `${a.ask ?? ""} ${a.detail ?? ""} ${a.url ?? ""}`.match(URL) ?? []) add(u.replace(/[.,;:]+$/, ""));
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
        .when(Boolean(a.short), (el) => el.child(div().flex_none().text_size(15).font_semibold().text_color(t.accent).child(a.short)))
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(a.title ?? a.ask ?? a.id ?? ""))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(a.title && a.ask), (el) => el.child(div().text_size(13.5).line_height("20px").child(a.ask)))
      .child(div().text_size(11.5).text_color(t.dim).child([a.project, a.session, due && `due ${due}`, a.created && `asked ${age(Date.parse(a.created))}`].filter(Boolean).join(" · ")))
      .when(Boolean(a.detail), (el) => el.child(div().id("ask-detail").max_h(260).overflow_y_scrollbar().text_size(12.5).line_height("19px").text_color(t.muted).child(a.detail)))
      .when(links.length > 0, (el) => el.child(v_flex().gap(2).children(links.map((l, k) => div().id(`ask-link-${k}`).truncate().text_size(12)
        .text_color(t.accent).cursor_pointer().hover((el) => el.underline()).on_click(() => exec("open", [l.url])).child(l.label)))))
      .child(v_flex().gap(6)
        .children(options.map((o, k) => h_flex().id(`ask-opt-${k}`).min_h(32).px(12).py(6).gap(10).items_start().rounded(7)
          .border_1().border_color(this.sent?.option === o ? t.solid : isRec(o, k) ? t.accent : t.input).bg(t.raised)
          .when(Boolean(this.channel) && this.sent?.state !== "sent", (el) => el.cursor_pointer().hover((el) => el.bg(t.hover)).on_click(this.choose(a, o)))
          .child(div().w(18).flex_none().font_semibold().text_color(isRec(o, k) ? t.accent : t.dim).child(`${k + 1}.`))
          .child(div().flex_1().min_w(0).child(o))
          .when(isRec(o, k), (el) => el.child(div().flex_none().text_size(11).font_semibold().text_color(t.accent).child("Recommended")))))
        .when(Boolean(rec) && !options.includes(rec) && !/^option\s*\d+\.?$/i.test(rec), (el) => el.child(div().text_size(12).text_color(t.muted).child(`Recommendation: ${rec}`)))
        .when(options.length > 0, (el) => el.child(div().text_size(11.5).text_color(this.sent?.state === "failed" ? t.blocked : t.dim).whitespace_normal()
          .child(this.sent?.state === "sent" ? `Sent to ${this.sent.to.join(" and ")}.`
            : this.sent?.state === "failed" ? `Not sent: ${this.sent.error}`
            : this.sent?.state === "sending" ? "Sending…"
            : this.channel ? `Press an option to send it to ${a.session}.`
            : `Answer in chat${a.short ? `, e.g. "${a.short} option 1"` : ""}.`))))
      .child(h_flex().gap(8).pt(4)
        .child(button("ask-open", "Open session", false, () => {
          closeOverlay(props().overlay);
          this.focusSession(a.project, a.session);
        }))
        .child(div().flex_1())
        .child(button("ask-close", "Close", false, () => closeOverlay(props().overlay))));
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
    const prs = once(placed(projects(this.files), this.prGroups(), this.authored)).flatMap((p) => p.prs)
      .filter((p) => (onlyNew ? !this.checked.has(p.id) : all || !this.checked.has(p.id) || !isMerged(this.live.get(p.id))));
    const owners = this.config.authored ? [].concat(this.config.authored.owners ?? []) : null;
    const search = !onlyNew && owners ? `is:pr is:open author:@me${owners.map((o) => ` user:${o}`).join("")}` : null;
    if (!prs.length && !search) return;
    this.busy = true;
    cx.notify();
    const mine = search ? `mine:search(query:${JSON.stringify(search)},type:ISSUE,first:100){nodes{... on PullRequest{number repository{owner{login} name} ${FIELDS}}}} ` : "";
    const query = `query{viewer{login} ${mine}${prs.map((p, i) => `p${i}:repository(owner:${JSON.stringify(p.owner)},name:${JSON.stringify(p.repo)}){pullRequest(number:${p.number}){${FIELDS}}}`).join(" ")}}`;
    try {
      const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]);
      const data = JSON.parse(r.stdout || "{}").data ?? {};
      if (data.viewer?.login) localStorage.setItem("viewer", (this.viewer = data.viewer.login));
      const reviews = (nodes) => (nodes ?? []).map((n) => ({ login: n.author?.login, state: n.state }));
      const live = (pr) => ({
        title: pr.title, summary: summaryOf(pr.body), url: pr.url, state: pr.state, draft: pr.isDraft, review: pr.reviewDecision, mergeable: pr.mergeable,
        base: pr.baseRefName, head: pr.headRefName, author: pr.author ? { login: pr.author.login, name: pr.author.name } : null,
        ci: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
        threads: (pr.reviewThreads?.nodes ?? []).filter((n) => !n.isResolved).length,
        reviews: reviews(pr.latestOpinionatedReviews?.nodes),
        latest: reviews(pr.latestReviews?.nodes),
      });
      prs.forEach((p, i) => {
        const pr = data[`p${i}`]?.pullRequest;
        this.checked.add(p.id);
        if (pr) this.live.set(p.id, live(pr));
      });
      // A search that failed keeps the last list, so a PR never drops off for a bad minute
      if (data.mine?.nodes) {
        this.authored = new Map(data.mine.nodes.filter((pr) => pr?.number).map((pr) => {
          const ref = { owner: pr.repository.owner.login, repo: pr.repository.name, number: pr.number };
          const id = `${ref.owner}/${ref.repo}#${ref.number}`;
          this.live.set(id, live(pr));
          return [id, { id, ...ref }];
        }));
        localStorage.setItem("authored", JSON.stringify([...this.authored]));
      }
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
      .when(p.repo !== this.usualRepo, (el) => el.child(div().flex_none().max_w(110).mr(6).truncate().text_color(t.dim).child(p.repo)))
      .child(div().flex_1().min_w(0).child(!pr ? div().truncate().text_color(t.dim).child(p.id)
        : HoverCard.new(`pr-card-${p.id}`).open_delay(450).close_delay(200).anchor("top_left")
          .trigger(div().w_full().truncate().text_color(final ? t.dim : t.muted).child(pr.title ?? p.id))
          .content(this.prCard(t, p, pr))));
  }

  // What a row truncates: the full title, and the summary from the PR's description
  prCard(t, p, pr) {
    const lines = (pr.summary ?? "").split("\n");
    return v_flex().w(380).p(12).gap(6).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_color(t.foreground)
      .child(div().text_size(11).text_color(t.dim).child(`${p.owner}/${p.repo}#${p.number}`))
      .child(div().whitespace_normal().text_size(13.5).line_height("19px").font_semibold().child(pr.title ?? p.id))
      .child(pr.summary
        ? v_flex().gap(2).text_size(12.5).line_height("18px").text_color(t.muted).children(lines.map((l) => {
          const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(l);
          if (!l.trim()) return div().h(4);
          if (!bullet) return div().whitespace_normal().child(l);
          return h_flex().items_start().gap(6).pl(bullet[1].length * 4)
            .child(div().flex_none().text_color(t.dim).child("•"))
            .child(div().flex_1().min_w(0).whitespace_normal().child(bullet[2]));
        }))
        : div().text_size(12).text_color(t.dim).child("No summary in its description."));
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
    // Most PRs share one repo; a row names its repo only when it is another one
    const repos = new Map();
    for (const proj of list) for (const p of proj.prs) repos.set(p.repo, (repos.get(p.repo) ?? 0) + 1);
    this.usualRepo = [...repos].sort((a, b) => b[1] - a[1])[0]?.[0];
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
    const me = who([...this.live.values()].find((pr) => pr?.author?.login === this.viewer)?.author);
    const options = {
      author: [...new Set(all.flatMap((proj) => proj.prs.map((p) => who(this.live.get(p.id)?.author))).filter(Boolean))]
        .sort((a, b) => (b === me) - (a === me) || a.localeCompare(b)).map((a) => ({ key: a, label: a === me ? `${a} (me)` : a })),
      status: STATUSES.map(([key, label]) => ({ key, label })),
      stream: streams.map((x) => ({ key: x.key, label: reviewing ? this.labels?.get(x.key) ?? x.name : !x.name ? x.project : named(x.name) > 1 ? `${x.project} / ${x.name}` : x.name })),
    };
    this.options = options;
    const shown = filtering
      ? all.map((proj) => ({ ...proj, prs: proj.prs.filter((p) => matches(proj, p)) })).filter((proj) => proj.prs.length)
      : all;
    const bar = h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(11.5)
      .children([["author", "Author"], ["status", "Status"], ["stream", "Workstream"]].map(([dim, label]) => {
        const n = pick(dim).length;
        return h_flex().id(`flt-${tab}-${dim}`).h(22).px(8).gap(5).items_center().rounded(5).border_1()
          .border_color(n ? t.accent : t.input).text_color(n ? t.foreground : t.muted).cursor_pointer().hover((el) => el.bg(t.hover))
          // A press reports the button's bounds, which a click does not, so the list opens under it
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.openFilter(tab, dim, label, options[dim], e.bounds);
          })
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
        if (title) items.push({ kind: "group", title, label: reviewing ? this.labels?.get(`${proj.name}/${g.title}`) : null, project, group, done, top, open: reviewing && g.title ? `${proj.name}/${g.title}` : null });
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
          .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(item.label || item.title)));
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

  openFilter(tab, dim, title, options, bounds) {
    const key = `${tab}/${dim}`;
    const was = shared(DROPDOWN);
    if (was?.key === key && (!was.closed || Date.now() - was.closed < 400)) {
      if (!was.closed) closeOverlay(was.id);
      return setShared(DROPDOWN, null);
    }
    if (was && !was.closed) closeOverlay(was.id);
    const id = openOverlay({
      mod: "session-prs", kind: "popup", width: 260, height: Math.min(52 + Math.max(options.length, 1) * 28, 560),
      ...(bounds && { at: { x: bounds.x, y: bounds.y + bounds.height + 4 } }),
      props: { mode: "filter", tab, dim, title, options },
    });
    setShared(DROPDOWN, { key, id });
  }

  async close() {
    const was = shared(DROPDOWN);
    if (props()?.mode === "filter" && was?.id === props()?.overlay) setShared(DROPDOWN, { ...was, closed: Date.now() });
  }

  filterPopup(t) {
    const { tab, dim, title, options } = props();
    const all = shared(FILTERS) ?? {};
    const chosen = all[tab]?.[dim] ?? [];
    const set = (next) => setShared(FILTERS, { ...all, [tab]: { ...(all[tab] ?? {}), [dim]: next } });
    return v_flex().w_full().p(6).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().px(8).pt(4).pb(6).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(title))
        .when(chosen.length > 0, (el) => el.child(div().id("flt-none").text_size(11).text_color(t.dim).cursor_pointer()
          .hover((el) => el.text_color(t.foreground)).on_click(() => set([])).child("clear"))))
      .when(!options?.length, (el) => el.child(div().px(8).py(4).text_color(t.dim).child("Nothing to filter by yet.")))
      .child(v_flex().id("flt-list").max_h(500).overflow_y_scrollbar().children((options ?? []).map((o, k) => {
        const on = chosen.includes(o.key);
        return h_flex().id(`flt-o-${k}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((el) => el.bg(t.hover))
          .on_click(() => set(on ? chosen.filter((x) => x !== o.key) : [...chosen, o.key]))
          .child(div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.popover)
            .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(on ? "✓" : ""))
          .child(div().flex_1().min_w(0).truncate().child(o.label));
      })));
  }

  // A review section is named for what it reviews: its session's `title` or `group`, else its one
  // PR's title, else the ticket key its PRs share, else the session's name.
  reviewLabels(reviews) {
    const labels = new Map();
    for (const proj of reviews) {
      const bySession = new Map();
      for (const p of proj.prs) bySession.set(p.group, [...(bySession.get(p.group) ?? []), p]);
      for (const [session, prs] of bySession) {
        const f = this.files.get(`${proj.name}/${session}`) ?? {};
        const titles = prs.map((p) => this.live.get(p.id)?.title).filter(Boolean);
        const keys = [...new Set(titles.map((x) => /\b[A-Z][A-Z0-9]+-\d+\b/.exec(x)?.[0]).filter(Boolean))];
        labels.set(`${proj.name}/${session}`, f.title || f.group || (prs.length === 1 && titles[0]) || (keys.length === 1 && keys[0]) || session);
      }
    }
    return labels;
  }

  focusSession(project, session) {
    const live = terminals().filter((t) => t.state === "live" && t.labels?.["tree.project"] === project);
    const t = live.find((t) => t.name === session) ?? (session === project ? live.find((t) => t.labels?.["tree.role"] !== "worker") : null);
    if (t) run("pane.focus", { terminal: t.address });
  }

  askList(t, groups) {
    if (!groups.length) return div().px(12).py(8).text_color(t.dim).child("Nothing waits on you.");
    const rows = groups.flatMap((g, i) => [
      h_flex().h(ROW).px(12).mt(i ? 10 : 2).items_center().border_b(1).border_color(t.border)
        .child(div().font_bold().text_color(t.foreground).child(g.title)),
      ...g.asks.map((ask) => {
        const a = { ...ask, short: this.ids[askRef(ask)] };
        const [due, tone] = dueLabel(a.due);
        return h_flex().id(`ask-${a.key}`).h(ROW).px(12).gap(8).items_center().whitespace_nowrap().rounded(5).cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click(() => openOverlay({ mod: "session-prs", kind: "dialog", width: 640, props: { mode: "ask", ask: a, folder: props()?.folder } }))
          .child(div().w(32).flex_none().text_color(t.dim).child(a.short ?? ""))
          // The due date and the asking session take room only when they say something the row doesn't
          .when(Boolean(due), (el) => el.child(div().flex_none().text_color(tone === "late" ? t.blocked : tone === "soon" ? t.ansi3 : t.dim).child(due)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.title ?? a.ask ?? a.id ?? ""))
          .when(Boolean(a.session) && a.session !== a.project, (el) => el.child(div().id(`ask-s-${a.key}`).max_w(96).flex_none().truncate().text_color(t.dim).cursor_pointer()
            .hover((el) => el.text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.focusSession(a.project, a.session);
            })
            .child(a.session)));
      }),
    ]);
    return v_flex().id("ask-list").flex_1().min_h(0).py(4).overflow_y_scrollbar().children(rows);
  }

  render() {
    const t = theme();
    if (props()?.mode === "ask") return this.askDialog(t);
    if (props()?.mode === "tracker-item") return trackerDialog(t, props(), () => closeOverlay(props().overlay), this.handle);
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
    this.labels = this.reviewLabels(reviews);
    const tabs = [...TABS, ...this.trackers.map((tr, i) => [`tracker:${i}`, trackerTitle(tr)])];
    const tracker = this.tab.startsWith("tracker:") ? this.trackers[Number(this.tab.slice(8))] : null;
    const tab = tracker || !this.tab.startsWith("tracker:") ? this.tab : "prs";
    const trackerOpen = (tr) => new Set(this.trackerOpen[tr.path] ?? ["gaps", tr.data?.sections?.[0]?.id]);
    const toggleTracker = (id, cx) => {
      const open = trackerOpen(tracker);
      open.has(id) ? open.delete(id) : open.add(id);
      this.trackerOpen = { ...this.trackerOpen, [tracker.path]: [...open] };
      localStorage.setItem("trackerOpen", JSON.stringify(this.trackerOpen));
      cx.notify();
    };
    const updated = Date.parse(tracker?.data?.updated_at ?? "");
    const body = tracker ? trackerBody(t, tracker, trackerOpen(tracker), toggleTracker, Number.isNaN(updated) ? "" : `updated ${age(updated)}`)
      : tab === "asks" ? this.askList(t, asks)
        : tab === "reviews" ? this.prList(t, once(reviews), true)
          : this.prList(t, once(placed(all, this.prGroups(), this.authored).filter((p) => p.name !== this.reviewsProject)), false);
    const status = tracker || tab === "asks" ? "" : this.error ?? (this.at ? `GitHub checked ${age(this.at)}` : this.busy ? "checking GitHub…" : "");
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .child(h_flex().h(34).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .children(tabs.map(([id, label], k) => {
          const gaps = k >= TABS.length ? gapCount(this.trackers[k - TABS.length]) : 0;
          return h_flex().id(`tab-${id}`).h(24).px(8).gap(5).items_center().rounded(5).cursor_pointer().whitespace_nowrap()
            .when(tab === id, (el) => el.bg(t.raised).text_color(t.foreground))
            .when(tab !== id, (el) => el.text_color(t.dim).hover((el) => el.text_color(t.foreground)))
            .on_click((_e, cx) => pick(id, cx))
            .child(label)
            .when(id === "asks" && count > 0, (el) => el.child(div().px(5).h(15).flex().items_center().rounded_full().bg(t.blocked)
              .text_size(10).font_bold().text_color(t.background).child(String(count))))
            .when(gaps > 0, (el) => el.child(div().px(5).h(15).flex().items_center().rounded_full().bg(t.ansi3)
              .text_size(10).font_bold().text_color(t.background).child(String(gaps))));
        }))
        .child(div().flex_1().min_w(0).ml(6).truncate().text_size(11).text_color(this.error ? t.blocked : t.dim).child(status))
        .when(tab !== "asks", (el) => el.child(div().id("pr-refresh").px(6).h(22).flex().items_center().rounded(5).text_color(t.muted).cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => cx.spawn(async (cx) => {
            if (tracker) await this.loadTrackers(cx);
            else await this.refresh(cx, true);
          })).child("refresh")))
        .child(div().id("pr-close").px(6).h(22).flex().items_center().rounded(5).text_color(t.muted).cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click(close).child("×")))
      .child(body);
  }
}
