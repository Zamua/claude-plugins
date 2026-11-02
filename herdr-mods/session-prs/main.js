// Every session's pull requests (`prs` in its state file), one dense row each: projects in their
// `order`, and inside each a section per `group`; PRs without one come first, under no heading. An entry's `stack_on` names the
// PR it sits on; without it the PR whose branch is its base.
// props: { folder } (the projects folder) and { block }, the layout block that shows it, which
// is left alone while hidden.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, run, layout, watchFolder, closeOverlay, settings } from "herdr";
import { folderOf, readFiles } from "./files.js";

const REFRESH_MS = 60000;
const FIELDS = "title url state isDraft reviewDecision mergeable baseRefName headRefName author{login ... on User{name}} " +
  "commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}}";

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

// Projects in order, each PR once under its first project; a coordinator's entry wins over a worker's.
function projects(files) {
  const byName = new Map();
  const entries = [...files].sort(([, a], [, b]) => Number(b.title !== undefined) - Number(a.title !== undefined));
  for (const [key, f] of entries) {
    const name = key.split("/")[0];
    const p = byName.get(name) ?? { name, title: name, order: Infinity, closed: false, prs: [] };
    if (f.title !== undefined) Object.assign(p, { title: f.title || name, order: f.order ?? Infinity, closed: Boolean(f.closed) });
    for (const x of f.prs ?? []) {
      const id = typeof x === "string" ? x : x?.pr;
      if (id && parse(id)) p.prs.push({ id, group: x?.group, on: x?.stack_on, ...parse(id) });
    }
    byName.set(name, p);
  }
  const seen = new Set();
  return [...byName.values()]
    .filter((p) => !p.closed)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map((p) => ({ ...p, prs: p.prs.filter((pr) => !seen.has(pr.id) && seen.add(pr.id)) }))
    .filter((p) => p.prs.length);
}

const stackedOn = (on) => (typeof on === "number" ? on : Number(/#(\d+)$/.exec(String(on ?? ""))?.[1]) || null);

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

export default class SessionPrs extends View {
  init(_props, cx) {
    this.folder = folderOf(props());
    this.files = new Map();
    this.live = new Map(JSON.parse(localStorage.getItem("live") ?? "[]"));
    this.viewer = localStorage.getItem("viewer");
    this.checked = new Set();
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

  // One GraphQL call for every PR that can still change; merged and closed ones are asked once
  // per pane start. `onlyNew`: just the PRs not asked yet, for a state file that gained one.
  async refresh(cx, all = false, onlyNew = false) {
    if (this.busy || (this.hidden() && !all)) return;
    const prs = projects(this.files).flatMap((p) => p.prs)
      .filter((p) => (onlyNew ? !this.checked.has(p.id) : all || !this.checked.has(p.id) || !isFinal(this.live.get(p.id))));
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
        this.live.set(p.id, {
          title: pr.title, url: pr.url, state: pr.state, draft: pr.isDraft, review: pr.reviewDecision, mergeable: pr.mergeable,
          base: pr.baseRefName, head: pr.headRefName, author: pr.author ? { login: pr.author.login, name: pr.author.name } : null,
          ci: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
          threads: (pr.reviewThreads?.nodes ?? []).filter((n) => !n.isResolved).length,
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
      rail: run.length < 2 ? "\u00a0" : k === 0 ? "┌" : k === run.length - 1 ? "└" : "│",
    })));
  }

  onOf(p, heads) {
    const pr = this.live.get(p.id);
    return stackedOn(p.on) ?? (pr?.base ? heads.get(`${p.owner}/${p.repo}:${pr.base}`) ?? null : null);
  }

  row(t, { p, rail }, heads, who) {
    const pr = this.live.get(p.id);
    const merged = isMerged(pr);
    const final = isFinal(pr);
    const url = pr?.url ?? `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`;
    const approved = pr?.review === "APPROVED";
    const action = !final && pr && (pr.threads > 0 || pr.review === "CHANGES_REQUESTED" || pr.ci === "FAILURE" || pr.ci === "ERROR" || pr.mergeable === "CONFLICTING");
    const ci = final ? t.dim : { SUCCESS: t.ansi2, FAILURE: t.ansi1, ERROR: t.ansi1, PENDING: t.ansi3, EXPECTED: t.ansi3 }[pr?.ci] ?? t.dim;
    const [word, color] = !pr ? ["", t.dim] : merged ? ["merged", t.ansi5] : pr.state === "CLOSED" ? ["closed", t.ansi1] : pr.draft ? ["draft", t.muted] : ["ready", t.ansi4];
    const on = this.onOf(p, heads);
    const tip = [pr?.threads ? `${pr.threads} unresolved` : "", pr?.mergeable === "CONFLICTING" ? "conflicting" : "", pr?.review === "CHANGES_REQUESTED" ? "changes requested" : ""].filter(Boolean).join(", ");
    const cell = (w, text, c) => div().w(w).flex_none().text_color(c).child(text);
    return h_flex().id(`pr-${p.id}`).h(22).flex_none().px(12).items_center().rounded(5).whitespace_nowrap()
      .hover((el) => el.bg(t.hover)).cursor_pointer().on_click(() => exec("open", [url]))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(cell(16, rail, t.dim))
      .child(cell(16, merged ? "◆" : approved ? "✓" : "", merged ? t.ansi5 : t.ansi2))
      .child(cell(14, action ? "!" : "", t.ansi3))
      .child(cell(54, `#${p.number}`, final ? t.dim : t.foreground))
      .child(h_flex().w(16).flex_none().child(div().size(8).rounded_full().bg(ci)
        .when(!final && pr?.ci === "PENDING", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1200 }))))
      .child(cell(56, word, color))
      .child(div().w(64).flex_none().mr(6).truncate().text_color(t.dim).child(who(pr?.author)))
      .when(Boolean(on), (el) => el.child(div().flex_none().mr(6).text_color(t.dim).child(`on #${on}`)))
      .child(div().flex_1().min_w(0).truncate().text_color(final ? t.dim : t.muted).child(pr?.title ?? p.id));
  }

  render() {
    const t = theme();
    const list = projects(this.files);
    const heads = new Map();
    for (const proj of list) for (const p of proj.prs) {
      const pr = this.live.get(p.id);
      if (pr?.head) heads.set(`${p.owner}/${p.repo}:${pr.head}`, p.number);
    }
    const who = (author) => firstName(author).toLowerCase();
    const blocks = list.map((proj, i) => {
      const groups = [];
      for (const p of proj.prs) {
        const title = p.group ?? "";
        let g = groups.find((g) => g.title === title);
        if (!g) (title ? groups.push((g = { title, prs: [] })) : groups.unshift((g = { title, prs: [] })));
        g.prs.push(p);
      }
      return v_flex().id(`pr-p-${i}`).flex_none().pt(i ? 16 : 2)
        .child(h_flex().h(24).px(12).items_center().border_b(1).border_color(t.border)
          .child(div().font_bold().text_color(t.foreground).child(proj.title)))
        .children(groups.map((g, j) => {
          return v_flex().id(`pr-g-${i}-${j}`).flex_none().pt(g.title ? 8 : 4)
            .when(Boolean(g.title), (el) => el.child(h_flex().h(22).px(12).items_center().whitespace_nowrap()
              .child(div().font_semibold().text_color(t.foreground).child(g.title))))
            .children(this.runs(g.prs, heads).map((n) => this.row(t, n, heads, who)));
        }));
    });
    const close = () => {
      const block = props()?.block;
      if (block && find(layout(), block)) run("layout.hide", { id: block });
      else if (props()?.overlay) closeOverlay(props().overlay);
    };
    const status = this.error ?? (this.at ? `GitHub checked ${age(this.at)}` : this.busy ? "checking GitHub…" : "");
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .child(h_flex().h(34).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.blocked : t.dim).child(status))
        .child(div().id("pr-refresh").px(6).h(22).flex().items_center().rounded(5).text_color(t.muted).cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => cx.spawn(async (cx) => {
            await this.refresh(cx, true);
          })).child("refresh"))
        .child(div().id("pr-close").px(6).h(22).flex().items_center().rounded(5).text_color(t.muted).cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click(close).child("×")))
      .child(v_flex().id("pr-list").flex_1().min_h(0).py(8).overflow_y_scrollbar()
        .children(blocks.length ? blocks : [div().px(12).py(8).text_color(t.dim).child("No session lists a pull request yet.")]));
  }
}
