// A work graph as cards and arrows, read only: each node a card with its id, title, owner session
// and status, each arrow from a blocker to what it blocks, in columns by dependency depth and
// lanes top to bottom (see graph.js for the file). A node is done, needs you (an open ask in a
// state file names it), in flight (its owner session is live), blocked (a blocker isn't done), or
// ready: nothing blocks it and nobody owns it, so it can start now.
//
// props: { file } (one graph file) and { folder } (the projects folder of state files). Without
// them, ~/.config/herdr-app/work-graph.json gives { graphs: [paths], folder }, a tab per graph.
// Open it in its own tab: herdr-app do tab.new --mod work-graph --props '{"file": "<path>"}'

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, terminals, spaces, watchFolder, readTextFile, home } from "herdr";
import { expand, readGraph, readFiles, linearIds, fetchLinear, prRefs, fetchPrs, openAsks, liveSessions, build, STATES } from "./graph.js";

const REFRESH_MS = 60000;
// Sizes at 100%; the graph scales them all
const CARD_W = 208;
const CARD_H = 76;
const GAP_X = 52;
const GAP_Y = 12;
const LANE_HEAD = 30;
const LANE_GAP = 8;
const PAD = 16;
// Below this the cards' text stops being readable, so a wider graph scrolls instead
const MIN_FIT = 0.6;
const ZOOMS = [0.6, 0.75, 0.9, 1, 1.15];
const SPINNER = "mods/work-graph/spinner.svg";

const WORD = { needs: "needs you", ready: "can start now", flight: "in flight", blocked: "blocked", done: "done" };
const SESSION = { working: "working", blocked: "waiting on a dialog" };
const color = (t, state) => ({ needs: t.blocked, ready: t.ansi2, flight: t.working, blocked: t.dim, done: t.done })[state];

async function readConfig() {
  try {
    return JSON.parse((await readTextFile(`${home()}/.config/herdr-app/work-graph.json`)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? "updated just now" : s < 3600 ? `updated ${Math.round(s / 60)}m ago` : `updated ${Math.round(s / 3600)}h ago`;
}

const openTarget = (target) => {
  if (target) exec("open", [/^https?:/.test(target) ? target : expand(target)]);
};
const linkOf = (n) => n.issue?.url ?? n.live?.url ?? n.link;
const widthOf = (g) => PAD * 2 + g.cols * CARD_W + Math.max(0, g.cols - 1) * GAP_X;

export default class WorkGraph extends View {
  init(_props, cx) {
    this.graphs = [];
    this.files = new Map();
    this.issues = new Map(JSON.parse(localStorage.getItem("issues") ?? "[]"));
    this.prs = new Map(JSON.parse(localStorage.getItem("prs") ?? "[]"));
    this.sel = Number(localStorage.getItem("sel") ?? 0) || 0;
    this.at = Number(localStorage.getItem("at") ?? 0) || 0;
    this.zoom = localStorage.getItem("zoom") ?? "fit";
    this.viewW = 0;
    this.error = null;
    this.busy = false;
    cx.spawn(async (cx) => {
      const config = await readConfig();
      this.paths = props()?.file ? [props().file] : Array.isArray(config.graphs) ? config.graphs : [];
      await this.loadGraphs(cx);
      await this.refresh(cx);
      const dirs = [...new Set(this.paths.map((p) => expand(p).replace(/\/[^/]*$/, "")))];
      if (!dirs.length) return;
      const asked = () => linearIds(this.graphs).join() + prRefs(this.graphs, this.issues).join();
      try {
        for (;;) {
          await Promise.race(dirs.map((d) => watchFolder(d)));
          const before = asked();
          await this.loadGraphs(cx);
          if (asked() !== before) await this.refresh(cx);
        }
      } catch {
        cx.timer.every(30000, (cx) => cx.spawn(async (cx) => this.loadGraphs(cx)));
      }
    });
    cx.spawn(async (cx) => {
      this.folder = expand(props()?.folder ?? (await readConfig()).folder ?? "~/projects");
      this.files = await readFiles(this.folder);
      cx.notify();
      try {
        for (;;) {
          await watchFolder(this.folder);
          this.files = await readFiles(this.folder);
          cx.notify();
        }
      } catch {
        cx.timer.every(30000, (cx) => cx.spawn(async (cx) => {
          this.files = await readFiles(this.folder);
          cx.notify();
        }));
      }
    });
    cx.timer.every(REFRESH_MS, (cx) => cx.spawn(async (cx) => this.refresh(cx)));
  }

  async loadGraphs(cx) {
    this.graphs = await Promise.all(this.paths.map(readGraph));
    cx.notify();
  }

  // Linear first, since an issue's GitHub link names its pull request; a failed call keeps the
  // last answer
  async refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    const errors = [];
    try {
      const l = await fetchLinear(linearIds(this.graphs));
      if (l.error) errors.push(`Linear: ${l.error}`);
      else this.issues = l.issues;
      const g = await fetchPrs(prRefs(this.graphs, this.issues));
      if (g.error) errors.push(`GitHub: ${g.error}`);
      else this.prs = g.prs;
      if (!errors.length) this.at = Date.now();
      localStorage.setItem("issues", JSON.stringify([...this.issues]));
      localStorage.setItem("prs", JSON.stringify([...this.prs]));
      localStorage.setItem("at", String(this.at));
    } catch (e) {
      errors.push(String(e?.message ?? e));
    }
    this.error = errors.join("; ") || null;
    this.busy = false;
    cx.notify();
  }

  scale(g) {
    if (this.zoom !== "fit") return Number(this.zoom) || 1;
    return this.viewW ? Math.max(MIN_FIT, Math.min(1, this.viewW / widthOf(g))) : 1;
  }

  setZoom(cx, z) {
    this.zoom = z;
    localStorage.setItem("zoom", String(z));
    cx.notify();
  }

  glyph(t, n, u) {
    const box = h_flex().w(u(10)).h(u(14)).flex_none().items_center().justify_center();
    if (n.state === "needs") return box.child(div().text_size(u(13)).font_bold().text_color(t.blocked).child("!"));
    if (n.state === "flight" && n.session.status === "working") return box.child(svg(SPINNER).size(u(10)).text_color(t.working).spin(900));
    if (n.state === "done") return box.child(div().text_size(u(11)).text_color(t.done).child("✓"));
    if (n.state === "blocked") return box.child(div().size(u(7)).rounded_full().border_1().border_color(t.dim));
    return box.child(div().size(u(7)).rounded_full().bg(color(t, n.state)));
  }

  caption(n) {
    const after = (list) => `after ${list.slice(0, 2).map((b) => b.id).join(", ")}${list.length > 2 ? ` +${list.length - 2}` : ""}`;
    if (n.state === "needs") return `needs you: ${n.waiting.map((a) => a.id).join(", ")}`;
    if (n.state === "flight") return `${SESSION[n.session.status] ?? "idle"}${n.blockers.length ? `, ${after(n.blockers)}` : ""}`;
    if (n.state === "blocked") return after(n.blockers);
    if (n.state === "ready") return "can start now";
    return n.issue?.stateName === "Canceled" ? "canceled" : n.live?.state === "MERGED" ? "merged" : "done";
  }

  tip(n) {
    const lines = [`${n.id}: ${n.title}`];
    if (n.issue?.stateName) lines.push(`Linear: ${n.issue.stateName}`);
    if (n.live) lines.push(`${n.pr}: ${n.live.state === "OPEN" && n.live.draft ? "draft" : n.live.state.toLowerCase()}`);
    if (n.owner) lines.push(`Owner: ${n.owner}${n.session ? `, ${SESSION[n.session.status] ?? "idle"}` : ", no live session"}`);
    if (n.waiting.length) lines.push(`Needs you: ${n.waiting.map((a) => a.id).join(", ")}`);
    if (n.blockers.length) lines.push(`Waits on ${n.blockers.map((b) => b.id).join(", ")}`);
    if (n.note) lines.push(n.note);
    return lines.join("\n");
  }

  card(t, n, x, y, u) {
    const tone = color(t, n.state);
    const prNumber = n.pr ? n.pr.split("#")[1] : null;
    const highlight = n.state === "ready" || n.state === "needs";
    return v_flex().id(`wg-${n.id}`).absolute().left(x).top(y).w(u(CARD_W)).h(u(CARD_H)).px(u(10)).py(u(7)).gap(u(2)).rounded(u(8))
      .bg(t.surface).border_1().border_color(highlight ? tone : t.border).when(n.state === "done", (el) => el.opacity(0.6))
      .cursor_pointer().hover((el) => el.bg(t.hover)).tooltip(this.tip(n)).on_click(() => openTarget(linkOf(n)))
      .child(h_flex().w_full().h(u(16)).gap(u(6)).items_center().whitespace_nowrap()
        .child(this.glyph(t, n, u))
        .child(div().flex_none().text_size(u(11.5)).font_semibold().text_color(t.muted).child(n.id))
        .when(Boolean(prNumber && n.pr !== n.id), (el) => el.child(div().id(`wg-pr-${n.id}`).flex_none().text_size(u(11.5)).text_color(t.accent)
          .hover((el) => el.underline()).on_click((_e, cx) => {
            cx.stop_propagation();
            openTarget(n.live?.url ?? `https://github.com/${n.pr.replace("#", "/pull/")}`);
          }).child(`#${prNumber}${n.live?.draft ? " draft" : ""}`)))
        .child(div().flex_1().min_w(0))
        .child(div().min_w(0).max_w(u(84)).truncate().text_size(u(11)).text_color(t.dim).child(n.owner ?? "")))
      .child(div().w_full().h(u(32)).overflow_hidden().whitespace_normal().text_size(u(12.5)).line_height(`${u(16)}px`)
        .text_color(n.state === "done" ? t.dim : t.foreground).child(n.title))
      .child(div().w_full().h(u(15)).truncate().text_size(u(11)).text_color(tone).child(this.caption(n)));
  }

  // One stroke and one fill per tone: arrows from a finished blocker are quieter. Ends spread
  // along a card's side so arrows meeting one card stay apart.
  edges(t, g, pos, u) {
    const outs = new Map();
    const ins = new Map();
    for (const e of g.edges) {
      outs.set(e.from, [...(outs.get(e.from) ?? []), e]);
      ins.set(e.to, [...(ins.get(e.to) ?? []), e]);
    }
    for (const l of outs.values()) l.sort((a, b) => pos.get(a.to).y - pos.get(b.to).y);
    for (const l of ins.values()) l.sort((a, b) => pos.get(a.from).y - pos.get(b.from).y);
    const spread = (list, e) => {
      const step = Math.min(u(8), u(CARD_H - 24) / Math.max(1, list.length - 1));
      return (list.indexOf(e) - (list.length - 1) / 2) * step;
    };
    const layers = [];
    for (const quiet of [true, false]) {
      const set = g.edges.filter((e) => g.byId.get(e.from).done === quiet);
      if (!set.length) continue;
      const line = PathBuilder.stroke(quiet ? 1 : 1.5);
      const heads = PathBuilder.fill();
      for (const e of set) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        const x1 = a.x + u(CARD_W);
        const y1 = a.y + u(CARD_H) / 2 + spread(outs.get(e.from), e);
        const x2 = b.x - u(6);
        const y2 = b.y + u(CARD_H) / 2 + spread(ins.get(e.to), e);
        const dx = Math.max(u(24), (x2 - x1) / 2);
        line.move_to(x1, y1).cubic_bezier_to(x2, y2, x1 + dx, y1, x2 - dx, y2);
        heads.add_polygon([[x2, y2 - u(4)], [b.x, y2], [x2, y2 + u(4)]], true);
      }
      const tone = quiet ? t.border : t.muted;
      layers.push(window.paint_path(line.build(), tone).absolute().top(0).left(0).size_full());
      layers.push(window.paint_path(heads.build(), tone).absolute().top(0).left(0).size_full());
    }
    return layers;
  }

  canvas(t, g, u) {
    const pos = new Map();
    const bands = [];
    let y = u(PAD);
    const width = u(widthOf(g));
    for (const lane of g.lanes) {
      const h = u(LANE_HEAD + lane.rows * CARD_H + Math.max(0, lane.rows - 1) * GAP_Y + LANE_GAP);
      bands.push(div().absolute().left(0).top(y).w(width).h(h).border_t(1).border_color(t.border)
        .child(div().absolute().left(u(PAD)).top(u(7)).text_size(u(11)).font_semibold().text_color(t.dim).child(lane.name)));
      for (const n of g.nodes.filter((n) => n.lane === lane.name)) {
        pos.set(n.id, { x: u(PAD + n.col * (CARD_W + GAP_X)), y: y + u(LANE_HEAD + n.row * (CARD_H + GAP_Y)) });
      }
      y += h;
    }
    return div().relative().flex_none().w(width).h(y + u(PAD))
      .children(bands)
      .children(this.edges(t, g, pos, u))
      .children(g.nodes.map((n) => this.card(t, n, pos.get(n.id).x, pos.get(n.id).y, u)));
  }

  button(t, id, label, active, onClick) {
    return div().id(id).px(6).h(22).flex().items_center().rounded(5).text_size(12).cursor_pointer()
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
  }

  summary(t, g, z) {
    const counts = STATES.map((s) => [s, g.nodes.filter((n) => n.state === s).length]).filter(([, k]) => k);
    const ready = g.nodes.filter((n) => n.state === "ready");
    const step = (dir) => (_e, cx) => {
      const i = ZOOMS.findIndex((x) => x >= z - 0.001);
      this.setZoom(cx, ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))]);
    };
    return v_flex().px(PAD).pt(10).pb(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(14).items_center().whitespace_nowrap()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(g.title))
        .children(counts.map(([s, k]) => div().text_size(12).text_color(s === "blocked" || s === "done" ? t.dim : color(t, s)).child(`${k} ${WORD[s]}`)))
        .child(div().flex_1())
        .child(div().min_w(0).truncate().text_size(11).text_color(this.error ? t.blocked : t.dim)
          .child(this.busy ? "updating" : this.error ?? ago(this.at)))
        .child(h_flex().gap(2)
          .child(this.button(t, "wg-zoom-out", "−", false, step(-1)))
          .child(this.button(t, "wg-zoom-fit", this.zoom === "fit" ? `fit ${Math.round(z * 100)}%` : `${Math.round(z * 100)}%`, this.zoom === "fit", (_e, cx) => this.setZoom(cx, "fit")))
          .child(this.button(t, "wg-zoom-in", "+", false, step(1))))
        .child(this.button(t, "wg-refresh", "refresh", false, (_e, cx) => cx.spawn(async (cx) => this.refresh(cx)))))
      .child(h_flex().gap(8).items_center().flex_wrap().text_size(12)
        .child(div().flex_none().text_color(ready.length ? t.ansi2 : t.dim).font_semibold().child(ready.length ? "Can start now:" : "Nothing can start now."))
        .children(ready.map((n) => div().id(`wg-ready-${n.id}`).flex_none().px(7).h(20).flex().items_center().rounded(5)
          .border_1().border_color(t.ansi2).text_color(t.foreground).cursor_pointer().hover((el) => el.bg(t.hover))
          .tooltip(this.tip(n)).on_click(() => openTarget(linkOf(n))).child(`${n.id} ${n.title}`))));
  }

  render() {
    const t = theme();
    const loaded = this.graphs[Math.min(this.sel, this.graphs.length - 1)];
    const root = v_flex().id("work-graph").size_full().bg(t.canvas).text_color(t.foreground);
    if (!this.paths) return root;
    if (!this.paths.length) return root.child(div().p(PAD).text_color(t.dim).child("No graph: pass props { file }, or list graphs in ~/.config/herdr-app/work-graph.json."));
    if (!loaded?.data) return root.child(div().p(PAD).text_color(loaded?.error ? t.blocked : t.dim).child(loaded?.error ?? "Reading the graph."));
    const g = build(loaded.data, this.issues, this.prs, openAsks(this.files), liveSessions(terminals(), spaces()));
    g.title = loaded.data.title ?? loaded.path.split("/").pop();
    const z = this.scale(g);
    const u = (x) => Math.round(x * z * 10) / 10;
    return root
      .when(this.graphs.length > 1, (el) => el.child(h_flex().px(PAD).pt(8).gap(4).children(this.graphs.map((gr, i) =>
        this.button(t, `wg-tab-${i}`, gr.data?.title ?? gr.path.split("/").pop(), i === this.sel, (_e, cx) => {
          this.sel = i;
          localStorage.setItem("sel", String(i));
          cx.notify();
        })))))
      .child(this.summary(t, g, z))
      .child(div().id("wg-scroll").flex_1().min_h(0).overflow_scrollbar()
        .on_size_change((size, cx) => {
          if (Math.abs(size.width - this.viewW) < 1) return;
          this.viewW = size.width;
          cx.notify();
        })
        .child(this.canvas(t, g, u)));
  }
}
