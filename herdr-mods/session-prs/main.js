// Every session's pull requests (`prs` in its state file), grouped by project in the projects'
// `order`, with live state from GitHub. props: { folder } (the projects folder) and { block },
// the layout block that shows it, which is left alone while hidden.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, run, layout, watchFolder, closeOverlay } from "herdr";
import { folderOf, readFiles } from "./files.js";

const ICON = (name) => `mods/session-prs/${name}.svg`;
const REFRESH_MS = 60000;
const FIELDS = "title url state isDraft reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}}";

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

// Projects in order, each with its sessions' PRs once; the coordinator's note wins over a worker's.
function groups(files) {
  const byProject = new Map();
  const entries = [...files].sort(([, a], [, b]) => Number(b.title !== undefined) - Number(a.title !== undefined));
  for (const [key, f] of entries) {
    const project = key.split("/")[0];
    const g = byProject.get(project) ?? { project, title: project, order: Infinity, closed: false, prs: new Map() };
    if (f.title !== undefined) Object.assign(g, { title: f.title || project, order: f.order ?? Infinity, closed: Boolean(f.closed) });
    for (const x of f.prs ?? []) {
      const id = typeof x === "string" ? x : x?.pr;
      if (id && parse(id) && !g.prs.has(id)) g.prs.set(id, { id, note: x?.note ?? "", ...parse(id) });
    }
    byProject.set(project, g);
  }
  return [...byProject.values()].filter((g) => !g.closed && g.prs.size).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

const isFinal = (pr) => pr?.state === "MERGED" || pr?.state === "CLOSED";
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default class SessionPrs extends View {
  init(_props, cx) {
    this.folder = folderOf(props());
    this.files = new Map();
    this.live = new Map(JSON.parse(localStorage.getItem("live") ?? "[]"));
    this.open = new Set();
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
    cx.timer.every(REFRESH_MS, (cx) => cx.spawn((cx) => this.refresh(cx)));
  }

  hidden() {
    const block = props()?.block;
    return Boolean(block && find(layout(), block)?.hidden);
  }

  // One GraphQL call for every PR that can still change; merged and closed ones are asked once
  // per pane start. `onlyNew`: just the PRs not asked yet, for a state file that gained one.
  async refresh(cx, all = false, onlyNew = false) {
    if (this.busy || (this.hidden() && !all)) return;
    const prs = groups(this.files).flatMap((g) => [...g.prs.values()])
      .filter((p) => (onlyNew ? !this.checked.has(p.id) : all || !this.checked.has(p.id) || !isFinal(this.live.get(p.id))));
    if (!prs.length) return;
    this.busy = true;
    cx.notify();
    const query = `query{${prs.map((p, i) => `p${i}:repository(owner:${JSON.stringify(p.owner)},name:${JSON.stringify(p.repo)}){pullRequest(number:${p.number}){${FIELDS}}}`).join(" ")}}`;
    try {
      const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]);
      const data = JSON.parse(r.stdout || "{}").data ?? {};
      prs.forEach((p, i) => {
        const pr = data[`p${i}`]?.pullRequest;
        this.checked.add(p.id);
        if (!pr) return;
        this.live.set(p.id, {
          title: pr.title, url: pr.url, state: pr.state, draft: pr.isDraft, review: pr.reviewDecision,
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

  badge(t, pr) {
    const [text, color] = !pr ? ["…", t.dim] : pr.state === "MERGED" ? ["merged", t.ansi5] : pr.state === "CLOSED" ? ["closed", t.ansi1] : pr.draft ? ["draft", t.dim] : ["open", t.ansi2];
    return div().w(50).flex_none().text_size(10.5).font_medium().text_color(color).child(text);
  }

  facts(t, pr) {
    if (!pr || isFinal(pr)) return [];
    const ci = { SUCCESS: t.ansi2, FAILURE: t.ansi1, ERROR: t.ansi1, PENDING: t.ansi3, EXPECTED: t.ansi3 }[pr.ci];
    const review = { APPROVED: ["approved", t.ansi2], CHANGES_REQUESTED: ["changes", t.ansi1], REVIEW_REQUIRED: ["review", t.dim] }[pr.review];
    return [
      pr.threads > 0 && div().flex_none().text_size(10.5).text_color(t.ansi3).child(`${pr.threads} unresolved`),
      review && div().flex_none().text_size(10.5).text_color(review[1]).child(review[0]),
      ci && div().size(7).flex_none().rounded_full().bg(ci).tooltip(`CI ${pr.ci.toLowerCase()}`)
        .when(pr.ci === "PENDING", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1200 })),
    ].filter(Boolean);
  }

  row(t, p) {
    const pr = this.live.get(p.id);
    const url = pr?.url ?? `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`;
    return v_flex().id(`pr-${p.id}`).flex_none().mx(8).px(8).py(4).rounded(7).hover((el) => el.bg(t.hover)).cursor_pointer()
      .on_click(() => exec("open", [url]))
      .child(h_flex().h(20).gap(8).items_center()
        .child(this.badge(t, pr))
        .child(div().w(118).flex_none().truncate().text_size(11.5).text_color(t.dim).child(`${p.repo}#${p.number}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(isFinal(pr) ? t.muted : t.foreground).child(pr?.title ?? ""))
        .children(this.facts(t, pr)))
      .when(Boolean(p.note), (el) => el.child(div().pl(176).truncate().text_size(11.5).text_color(t.dim).child(p.note)));
  }

  render() {
    const t = theme();
    const list = groups(this.files);
    const rows = [];
    let open = 0;
    for (const g of list) {
      const prs = [...g.prs.values()];
      const live = prs.filter((p) => !isFinal(this.live.get(p.id)));
      const final = prs.filter((p) => isFinal(this.live.get(p.id)));
      open += live.length;
      rows.push(h_flex().px(16).pt(14).pb(4).gap(8).items_center()
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(g.title))
        .child(div().text_size(11).text_color(t.dim).child(`${live.length} open`)));
      rows.push(...live.map((p) => this.row(t, p)));
      if (!final.length) continue;
      const shown = this.open.has(g.project);
      rows.push(h_flex().id(`pr-fold-${g.project}`).mx(8).px(8).h(24).gap(6).items_center().rounded(7)
        .text_size(11.5).text_color(t.dim).cursor_pointer().hover((el) => el.text_color(t.foreground))
        .on_click((_e, cx) => {
          shown ? this.open.delete(g.project) : this.open.add(g.project);
          cx.notify();
        })
        .child(svg(ICON(shown ? "chevron-down" : "chevron-right")).size(11))
        .child(`${final.length} merged or closed`));
      if (shown) rows.push(...final.map((p) => this.row(t, p)));
    }
    const close = () => {
      const block = props()?.block;
      if (block && find(layout(), block)) run("layout.hide", { id: block });
      else if (props()?.overlay) closeOverlay(props().overlay);
    };
    const status = this.error ?? (this.busy ? "updating…" : this.at ? `as of ${clock(this.at)}` : "");
    return v_flex().id("root").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Pull requests"))
        .child(div().text_size(11.5).text_color(t.dim).child(`${open} open`))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim).truncate().child(status))
        .child(div().id("pr-refresh").px(6).h(22).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => cx.spawn((cx) => this.refresh(cx, true))).child("Refresh"))
        .child(div().id("pr-close").px(6).h(22).flex().items_center().rounded(6).text_size(13).text_color(t.muted).cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click(close).child("×")))
      .child(v_flex().id("pr-list").flex_1().min_h(0).pb(10).overflow_y_scrollbar()
        .children(rows.length ? rows : [div().px(16).py(12).text_size(12).text_color(t.dim).child("No session lists a pull request yet.")]));
  }
}
