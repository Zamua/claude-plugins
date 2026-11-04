// All tracked work as a DAG that zooms: a lane per open project, and inside it the project's
// nodes nested by parent (see graph.js). A collapsed node is one card that rolls up the status of
// everything in it; an expanded one is a frame around its children. Arrows run from each blocker
// to what it blocks, combined between collapsed cards with a count, in columns by dependency depth
// among what shows. A leaf is done, needs you (an open ask names it), in flight (its owner session
// is live), blocked (a blocker isn't done), or ready: nothing blocks it and nobody owns it.
//
// The level buttons expand everything above that depth (0: projects only); a card's chevron opens
// or closes that one node, and its body opens its link. Commands work-graph.level0 to level3 and
// work-graph.refresh do the same from a key or a script. props or ~/.config/herdr-app/work-graph.json
// give { folder }, the projects folder of state files.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, terminals, spaces, watchFolder, readTextFile, home, nextCommand } from "herdr";
import { expand, readFiles, projectList, readGraph, linearIds, fetchLinear, prRefs, fetchPrs, openAsks, liveSessions, rootProject, build, visible, STATES } from "./graph.js";

const REFRESH_MS = 60000;
// Sizes at 100%; the graph scales them all
const CARD_W = 208;
const CARD_H = 76;
const GAP_X = 52;
const GAP_Y = 12;
const LANE_HEAD = 30;
const GROUP_HEAD = 24;
const FRAME_PAD = 8;
const PAD = 16;
// Below this the cards' text stops being readable, so a wider graph scrolls instead
const MIN_FIT = 0.6;
const ZOOMS = [0.6, 0.75, 0.9, 1, 1.15];
const LEVELS = [0, 1, 2, 3];
const SPINNER = "mods/work-graph/spinner.svg";
const CHEVRON = (open) => `mods/work-graph/chevron-${open ? "down" : "right"}.svg`;

const WORD = { needs: ["needs you", "need you"], ready: ["ready"], flight: ["in flight"], blocked: ["blocked"], done: ["done"] };
const word = (s, k) => (k === 1 ? WORD[s][0] : WORD[s][1] ?? WORD[s][0]);
const SESSION = { working: "working", blocked: "waiting on a dialog" };
const color = (t, state) => ({ needs: t.blocked, ready: t.ansi2, flight: t.working, blocked: t.dim, done: t.done })[state];
const countsText = (counts) => STATES.filter((s) => counts[s]).map((s) => `${counts[s]} ${word(s, counts[s])}`).join(", ");

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

// Lanes top to bottom; inside an expanded node, its own cards in rows by column, then each
// expanded child as a band of its own, so frames never overlap. Unscaled pixels.
function layout(model, vis) {
  const { nodes } = model;
  const cardSet = new Set(vis.cards);
  const frameSet = new Set(vis.frames);
  const order = new Map([...nodes.keys()].map((k, i) => [k, i]));
  const nest = new Map();
  const nestOf = (key) => {
    if (!nest.has(key)) nest.set(key, nodes.get(key).children.filter((k) => frameSet.has(k)).reduce((m, k) => Math.max(m, nestOf(k) + 1), 0));
    return nest.get(key);
  };
  const inner = vis.frames.filter((k) => nodes.get(k).kind !== "project");
  const maxPad = inner.reduce((m, k) => Math.max(m, FRAME_PAD * (1 + nestOf(k))), 0);
  const left = PAD + maxPad;
  const colX = (c) => left + c * (CARD_W + GAP_X);
  const pos = new Map();
  const boxes = new Map();
  const lanes = [];

  const band = (key, y0, lane) => {
    const n = nodes.get(key);
    let y = y0 + (lane ? LANE_HEAD : GROUP_HEAD);
    const direct = n.children.filter((k) => cardSet.has(k));
    if (direct.length) {
      const cols = new Map();
      for (const k of direct) cols.set(vis.col.get(k), [...(cols.get(vis.col.get(k)) ?? []), k]);
      let rows = 0;
      for (const [c, list] of [...cols].sort(([a], [b]) => a - b)) {
        const mean = (k) => {
          const ys = [...vis.cardPreds.get(k)].map((p) => pos.get(p)?.y).filter((v) => v !== undefined);
          return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : Infinity;
        };
        list.map((k) => [k, mean(k)]).sort((a, b) => a[1] - b[1] || order.get(a[0]) - order.get(b[0]))
          .forEach(([k], i) => pos.set(k, { x: colX(c), y: y + i * (CARD_H + GAP_Y) }));
        rows = Math.max(rows, list.length);
      }
      y += rows * (CARD_H + GAP_Y);
    }
    for (const k of n.children.filter((k) => frameSet.has(k))) y += band(k, y, false) + GAP_Y;
    const h = y - y0 + (lane ? 0 : FRAME_PAD - GAP_Y);
    if (!lane) boxes.set(key, { y: y0, h, pad: FRAME_PAD * (1 + nestOf(key)) });
    return h;
  };

  let y = PAD;
  for (const key of model.projects) {
    if (frameSet.has(key)) {
      const h = band(key, y, true);
      lanes.push({ key, y, h, open: true });
      y += h;
    } else {
      pos.set(key, { x: colX(vis.col.get(key)), y: y + GAP_Y });
      lanes.push({ key, y, h: CARD_H + GAP_Y * 2, open: false });
      y += CARD_H + GAP_Y * 2;
    }
  }
  for (const [key, box] of boxes) {
    const xs = vis.cards.filter((c) => nodes.get(c).ancestors.includes(key)).map((c) => pos.get(c).x);
    box.x = Math.min(...xs) - box.pad;
    box.w = Math.max(...xs) - Math.min(...xs) + CARD_W + box.pad * 2;
  }
  const maxCol = vis.cards.reduce((m, c) => Math.max(m, vis.col.get(c)), 0);
  const width = colX(maxCol) + CARD_W + maxPad + PAD;
  return { pos, boxes, lanes, width, height: y + PAD, left };
}

export default class WorkGraph extends View {
  init(_props, cx) {
    this.files = new Map();
    this.graphs = new Map();
    this.projects = [];
    this.issues = new Map(JSON.parse(localStorage.getItem("issues") ?? "[]"));
    this.prs = new Map(JSON.parse(localStorage.getItem("prs") ?? "[]"));
    this.notLinear = new Set();
    this.at = Number(localStorage.getItem("at") ?? 0) || 0;
    this.zoom = localStorage.getItem("zoom") ?? "fit";
    this.level = Number(localStorage.getItem("level") ?? 1);
    this.open = new Map(Object.entries(JSON.parse(localStorage.getItem("open") ?? "{}")));
    this.viewW = 0;
    this.error = null;
    this.busy = false;
    this.loaded = false;
    // State files, then each project's graph file; a change under the projects folder or a graph
    // kept elsewhere reloads both
    cx.spawn(async (cx) => {
      this.folder = expand(props()?.folder ?? (await readConfig()).folder ?? "~/projects");
      await this.load(cx);
      await this.refresh(cx);
      for (;;) {
        const outside = [...new Set(this.projects.map((p) => p.graph).filter((g) => !g.startsWith(`${this.folder}/`)).map((g) => g.replace(/\/[^/]*$/, "")))];
        try {
          await Promise.race([this.folder, ...outside].map((d) => watchFolder(d)));
        } catch {
          await new Promise((r) => cx.timer.after(30000, () => r()));
        }
        const before = this.asked();
        await this.load(cx);
        if (this.asked() !== before) await this.refresh(cx);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const m = /^level(\d)$/.exec(c);
        if (m) this.setLevel(cx, Number(m[1]));
        if (c === "refresh") await this.refresh(cx);
        if (c === "fit") this.setZoom(cx, "fit");
      }
    });
    cx.timer.every(REFRESH_MS, (cx) => cx.spawn(async (cx) => this.refresh(cx)));
  }

  asked() {
    return linearIds(this.graphs).join() + prRefs(this.graphs, this.issues).join();
  }

  async load(cx) {
    this.files = await readFiles(this.folder);
    this.projects = projectList(this.folder, this.files, rootProject(terminals()));
    const read = await Promise.all(this.projects.map(async (p) => [p.name, await readGraph(p.graph)]));
    this.graphs = new Map(read);
    this.loaded = true;
    cx.notify();
  }

  // Linear first, since an issue's GitHub link names its pull request; a failed call keeps the
  // last answer
  async refresh(cx) {
    if (this.busy || !this.loaded) return;
    this.busy = true;
    cx.notify();
    const errors = [];
    try {
      const l = await fetchLinear(linearIds(this.graphs).filter((id) => !this.notLinear.has(id)));
      if (l.error) errors.push(`Linear: ${l.error}`);
      else this.issues = l.issues;
      for (const id of l.missing ?? []) this.notLinear.add(id);
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

  isOpen(n) {
    return this.open.has(n.key) ? this.open.get(n.key) : n.level < this.level;
  }

  toggle(cx, n) {
    this.open.set(n.key, !this.isOpen(n));
    localStorage.setItem("open", JSON.stringify(Object.fromEntries(this.open)));
    cx.notify();
  }

  // A level resets every node opened or closed by hand
  setLevel(cx, level) {
    this.level = level;
    this.open = new Map();
    localStorage.setItem("level", String(level));
    localStorage.setItem("open", "{}");
    cx.notify();
  }

  setZoom(cx, z) {
    this.zoom = z;
    localStorage.setItem("zoom", String(z));
    cx.notify();
  }

  glyph(t, n, u) {
    const box = h_flex().w(u(10)).h(u(14)).flex_none().items_center().justify_center();
    if (n.state === "needs") return box.child(div().text_size(u(13)).font_bold().text_color(t.blocked).child("!"));
    if (n.state === "flight" && n.session?.status === "working") return box.child(svg(SPINNER).size(u(10)).text_color(t.working).spin(900));
    if (n.state === "done") return box.child(div().text_size(u(11)).text_color(t.done).child("✓"));
    if (n.state === "blocked") return box.child(div().size(u(7)).rounded_full().border_1().border_color(t.dim));
    return box.child(div().size(u(7)).rounded_full().bg(color(t, n.state)));
  }

  caption(n, sessions) {
    if (n.children.length) return countsText(n.counts);
    const after = (list) => `after ${list.slice(0, 2).map((b) => b.id).join(", ")}${list.length > 2 ? ` +${list.length - 2}` : ""}`;
    if (n.state === "needs") return `needs you: ${n.waiting.map((a) => a.id).join(", ")}`;
    if (n.kind === "project") {
      const live = sessions.projects.get(n.project) ?? [];
      return live.length ? `${live.length} session${live.length === 1 ? "" : "s"} live${live.some((s) => s.status === "working") ? ", working" : ""}` : "no session live";
    }
    if (n.state === "flight") return `${SESSION[n.session.status] ?? "idle"}${n.blockers.length ? `, ${after(n.blockers)}` : ""}`;
    if (n.state === "blocked") return after(n.blockers);
    if (n.state === "ready") return "can start now";
    return n.issue?.stateName === "Canceled" ? "canceled" : n.live?.state === "MERGED" ? "merged" : "done";
  }

  tip(n) {
    const lines = [n.kind === "project" ? n.title : `${n.id}: ${n.title}`];
    if (n.kind === "project" && n.info.next) lines.push(`Next: ${String(n.info.next).slice(0, 240)}`);
    if (n.issue?.stateName) lines.push(`Linear: ${n.issue.stateName}`);
    if (n.live) lines.push(`${n.pr}: ${n.live.state === "OPEN" && n.live.draft ? "draft" : n.live.state.toLowerCase()}`);
    if (n.owner) lines.push(`Owner: ${n.owner}${n.session ? `, ${SESSION[n.session.status] ?? "idle"}` : ", no live session"}`);
    if (n.counts) lines.push(countsText(n.counts));
    if (n.waiting.length) lines.push(`Needs you: ${n.waiting.map((a) => a.id).join(", ")}`);
    if (n.blockers.length) lines.push(`Waits on ${n.blockers.map((b) => b.id).join(", ")}`);
    if (n.note) lines.push(String(n.note).slice(0, 300));
    if (n.error) lines.push(n.error);
    return lines.join("\n");
  }

  chevron(t, n, u) {
    return div().id(`wg-chev-${n.key}`).flex_none().size(u(14)).flex().items_center().justify_center().rounded(u(3))
      .text_color(t.muted).hover((el) => el.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggle(cx, n);
      })
      .child(svg(CHEVRON(this.isOpen(n))).size(u(10)));
  }

  card(t, n, x, y, u, sessions) {
    const tone = color(t, n.state);
    const prNumber = n.pr ? n.pr.split("#")[1] : null;
    const group = n.children.length > 0;
    const highlight = (n.state === "ready" && !group && n.kind !== "project") || n.state === "needs";
    return v_flex().id(`wg-${n.key}`).absolute().left(x).top(y).w(u(CARD_W)).h(u(CARD_H)).px(u(10)).py(u(7)).gap(u(2)).rounded(u(8))
      .bg(group ? t.raised : t.surface).border_1().border_color(highlight ? tone : t.border).when(n.state === "done", (el) => el.opacity(0.6))
      .cursor_pointer().hover((el) => el.bg(t.hover)).tooltip(this.tip(n))
      .on_click((_e, cx) => {
        if (n.link) openTarget(n.link);
        else if (group) this.toggle(cx, n);
      })
      .child(h_flex().w_full().h(u(16)).gap(u(6)).items_center().whitespace_nowrap()
        .when(group, (el) => el.child(this.chevron(t, n, u)))
        .child(this.glyph(t, n, u))
        .child(div().flex_none().text_size(u(11.5)).font_semibold().text_color(t.muted).child(n.kind === "project" ? "project" : n.id))
        .when(Boolean(prNumber && n.pr !== n.id), (el) => el.child(div().id(`wg-pr-${n.key}`).flex_none().text_size(u(11.5)).text_color(t.accent)
          .hover((el) => el.underline()).on_click((_e, cx) => {
            cx.stop_propagation();
            openTarget(n.live?.url ?? `https://github.com/${n.pr.replace("#", "/pull/")}`);
          }).child(`#${prNumber}${n.live?.draft ? " draft" : ""}`)))
        .child(div().flex_1().min_w(0))
        .child(div().min_w(0).max_w(u(84)).truncate().text_size(u(11)).text_color(t.dim).child(n.owner ?? "")))
      .child(div().w_full().h(u(32)).overflow_hidden().whitespace_normal().text_size(u(12.5)).line_height(`${u(16)}px`)
        .text_color(n.state === "done" ? t.dim : t.foreground).when(group, (el) => el.font_semibold()).child(n.title))
      .child(div().w_full().h(u(15)).truncate().text_size(u(11)).text_color(group ? t.muted : tone).child(this.caption(n, sessions)));
  }

  // A frame around an expanded node's children, its header the handle that closes it. Frames
  // draw over the arrows, so the header hides an arrow passing under it.
  frame(t, n, box, u) {
    return [
      div().absolute().left(u(box.x)).top(u(box.y)).w(u(box.w)).h(u(box.h)).rounded(u(10)).border_1().border_color(t.border),
      h_flex().id(`wg-frame-${n.key}`).absolute().left(u(box.x + 6)).top(u(box.y + 4)).max_w(u(box.w - 12)).h(u(GROUP_HEAD - 6)).gap(u(6)).px(u(4))
        .items_center().whitespace_nowrap().rounded(u(4)).bg(t.canvas).cursor_pointer().hover((el) => el.bg(t.hover)).tooltip(this.tip(n))
        .on_click((_e, cx) => this.toggle(cx, n))
        .child(svg(CHEVRON(true)).flex_none().size(u(10)).text_color(t.muted))
        .child(div().flex_none().text_size(u(11.5)).font_semibold().text_color(t.foreground).child(n.title))
        .child(div().min_w(0).truncate().text_size(u(11)).text_color(color(t, n.state)).child(countsText(n.counts))),
    ];
  }

  // One stroke and one fill per tone: arrows from a finished blocker are quieter. Ends spread
  // along a side so arrows meeting one card stay apart; a combined arrow carries its count.
  edges(t, model, vis, lay, u) {
    const rect = (key) => {
      const p = lay.pos.get(key);
      if (p) return { x: p.x, y: p.y, w: CARD_W, h: CARD_H };
      const b = lay.boxes.get(key);
      if (b) return b;
      const lane = lay.lanes.find((l) => l.key === key);
      return { x: lay.left, y: lane.y, w: lay.width - lay.left, h: lane.h };
    };
    const outs = new Map();
    const ins = new Map();
    for (const e of vis.edges) {
      outs.set(e.from, [...(outs.get(e.from) ?? []), e]);
      ins.set(e.to, [...(ins.get(e.to) ?? []), e]);
    }
    for (const l of outs.values()) l.sort((a, b) => rect(a.to).y - rect(b.to).y);
    for (const l of ins.values()) l.sort((a, b) => rect(a.from).y - rect(b.from).y);
    const spread = (list, e, h) => {
      const step = Math.min(8, Math.max(0, h - 24) / Math.max(1, list.length - 1));
      return (list.indexOf(e) - (list.length - 1) / 2) * step;
    };
    const layers = [];
    const labels = [];
    for (const quiet of [true, false]) {
      const set = vis.edges.filter((e) => model.nodes.get(e.from).done === quiet);
      if (!set.length) continue;
      const line = PathBuilder.stroke(quiet ? 1 : 1.5);
      const heads = PathBuilder.fill();
      for (const e of set) {
        const a = rect(e.from);
        const b = rect(e.to);
        const x1 = u(a.x + a.w);
        const y1 = u(a.y + a.h / 2 + spread(outs.get(e.from), e, a.h));
        const x2 = u(b.x) - u(6);
        const y2 = u(b.y + b.h / 2 + spread(ins.get(e.to), e, b.h));
        const dx = Math.max(u(24), Math.abs(x2 - x1) / 2);
        line.move_to(x1, y1).cubic_bezier_to(x2, y2, x1 + dx, y1, x2 - dx, y2);
        heads.add_polygon([[x2, y2 - u(4)], [u(b.x), y2], [x2, y2 + u(4)]], true);
        if (e.count > 1) {
          labels.push(div().absolute().left((x1 + x2) / 2 - u(9)).top((y1 + y2) / 2 - u(8)).h(u(16)).min_w(u(18)).px(u(4)).rounded_full()
            .flex().items_center().justify_center().bg(t.raised).border_1().border_color(t.border)
            .text_size(u(10)).text_color(t.muted).child(String(e.count)));
        }
      }
      const tone = quiet ? t.border : t.muted;
      layers.push(window.paint_path(line.build(), tone).absolute().top(0).left(0).size_full());
      layers.push(window.paint_path(heads.build(), tone).absolute().top(0).left(0).size_full());
    }
    return [...layers, ...labels];
  }

  canvas(t, model, vis, lay, u, sessions) {
    const lanes = lay.lanes.map((l) => {
      const n = model.nodes.get(l.key);
      return div().absolute().left(0).top(u(l.y)).w(u(lay.width)).h(u(l.h)).border_t(1).border_color(t.border)
        .when(l.open, (el) => el.child(h_flex().id(`wg-lane-${n.key}`).absolute().left(u(PAD - 4)).top(u(5)).h(u(LANE_HEAD - 10)).gap(u(6)).px(u(4))
          .items_center().whitespace_nowrap().rounded(u(4)).cursor_pointer().hover((el) => el.bg(t.hover)).tooltip(this.tip(n))
          .on_click((_e, cx) => this.toggle(cx, n))
          .child(svg(CHEVRON(true)).flex_none().size(u(10)).text_color(t.muted))
          .child(div().flex_none().text_size(u(12.5)).font_semibold().text_color(t.foreground).child(n.title))
          .child(div().flex_none().text_size(u(11)).text_color(color(t, n.state)).child(countsText(n.counts)))));
    });
    const frames = [...lay.boxes].flatMap(([key, box]) => this.frame(t, model.nodes.get(key), box, u));
    return div().relative().flex_none().w(u(lay.width)).h(u(lay.height))
      .children(lanes)
      .children(this.edges(t, model, vis, lay, u))
      .children(frames)
      .children(vis.cards.map((k) => this.card(t, model.nodes.get(k), u(lay.pos.get(k).x), u(lay.pos.get(k).y), u, sessions)));
  }

  button(t, id, label, active, onClick) {
    return div().id(id).px(6).h(22).flex().items_center().rounded(5).text_size(12).cursor_pointer()
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
  }

  summary(t, model, z) {
    const leaves = model.leaves.filter((n) => n.kind !== "project");
    const counts = Object.fromEntries(STATES.map((s) => [s, leaves.filter((n) => n.state === s).length]));
    const ready = leaves.filter((n) => n.state === "ready");
    const step = (dir) => (_e, cx) => {
      const i = ZOOMS.findIndex((x) => x >= z - 0.001);
      this.setZoom(cx, ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))]);
    };
    const handTouched = this.open.size > 0;
    return v_flex().px(PAD).pt(10).pb(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(14).items_center().whitespace_nowrap()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Work graph"))
        .children(STATES.filter((s) => counts[s]).map((s) => div().text_size(12).text_color(s === "blocked" || s === "done" ? t.dim : color(t, s)).child(`${counts[s]} ${word(s, counts[s])}`)))
        .child(div().flex_1())
        .child(div().min_w(0).truncate().text_size(11).text_color(this.error ? t.blocked : t.dim)
          .child(this.busy ? "updating" : this.error ?? ago(this.at)))
        .child(h_flex().gap(2).items_center()
          .child(div().text_size(12).text_color(t.dim).mr(2).child("level"))
          .children(LEVELS.map((l) => this.button(t, `wg-level-${l}`, `${l}${handTouched && l === this.level ? "*" : ""}`, l === this.level, (_e, cx) => this.setLevel(cx, l)))))
        .child(h_flex().gap(2)
          .child(this.button(t, "wg-zoom-out", "−", false, step(-1)))
          .child(this.button(t, "wg-zoom-fit", this.zoom === "fit" ? `fit ${Math.round(z * 100)}%` : `${Math.round(z * 100)}%`, this.zoom === "fit", (_e, cx) => this.setZoom(cx, "fit")))
          .child(this.button(t, "wg-zoom-in", "+", false, step(1))))
        .child(this.button(t, "wg-refresh", "refresh", false, (_e, cx) => cx.spawn(async (cx) => this.refresh(cx)))))
      .child(h_flex().gap(8).items_center().flex_wrap().text_size(12)
        .child(div().flex_none().text_color(ready.length ? t.ansi2 : t.dim).font_semibold().child(ready.length ? "Can start now:" : "Nothing can start now."))
        .children(ready.slice(0, 8).map((n) => div().id(`wg-ready-${n.key}`).flex_none().px(7).h(20).flex().items_center().rounded(5)
          .border_1().border_color(t.ansi2).text_color(t.foreground).cursor_pointer().hover((el) => el.bg(t.hover))
          .tooltip(this.tip(n)).on_click(() => openTarget(n.link)).child(`${n.id} ${n.title}`)))
        .when(ready.length > 8, (el) => el.child(div().text_color(t.dim).child(`+${ready.length - 8} more`))));
  }

  render() {
    const t = theme();
    const root = v_flex().id("work-graph").size_full().bg(t.canvas).text_color(t.foreground);
    if (!this.loaded) return root.child(div().p(PAD).text_color(t.dim).child("Reading the projects."));
    if (!this.projects.length) return root.child(div().p(PAD).text_color(t.dim).child(`No open projects in ${this.folder}.`));
    const sessions = liveSessions(terminals(), spaces());
    const model = build({ projects: this.projects, graphs: this.graphs, issues: this.issues, prs: this.prs, asks: openAsks(this.files), sessions });
    const vis = visible(model, (n) => this.isOpen(n));
    const lay = layout(model, vis);
    const z = this.zoom !== "fit" ? Number(this.zoom) || 1 : this.viewW ? Math.max(MIN_FIT, Math.min(1, this.viewW / lay.width)) : 1;
    const u = (x) => Math.round(x * z * 10) / 10;
    return root
      .child(this.summary(t, model, z))
      .child(div().id("wg-scroll").flex_1().min_h(0).overflow_scrollbar()
        .on_size_change((size, cx) => {
          if (Math.abs(size.width - this.viewW) < 1) return;
          this.viewW = size.width;
          cx.notify();
        })
        .child(this.canvas(t, model, vis, lay, u, sessions)));
  }
}
