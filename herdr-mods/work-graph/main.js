// All tracked work as a DAG that zooms: a lane per open project, and inside it the project's
// nodes nested by parent (see graph.js). A collapsed node is one card that rolls up the status of
// everything in it; an expanded one is a frame around its children. Arrows run from each blocker
// to what it blocks, combined between collapsed cards with a count, in columns by dependency depth
// among what shows. A leaf is done, needs you (an open ask names it), in flight (its owner session
// is working), blocked (a blocker isn't done), owned but idle (its owner is live and not working),
// or ready: nothing blocks it and nobody owns it.
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
const CARD_W = 204;
const CARD_H = 72;
const GAP_X = 48;
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
const LOCK = "mods/work-graph/lock.svg";
const CHEVRON = (open) => `mods/work-graph/chevron-${open ? "down" : "right"}.svg`;

const WORD = { needs: ["needs you", "need you"], ready: ["ready"], flight: ["in flight"], idle: ["owned, idle"], blocked: ["blocked"], done: ["done"] };
const word = (s, k) => (k === 1 ? WORD[s][0] : WORD[s][1] ?? WORD[s][0]);
const SESSION = { working: "working", blocked: "waiting on a dialog" };
const color = (t, state) => ({ needs: t.working, ready: t.ansi2, flight: t.accent, idle: t.dim, blocked: t.blocked, done: t.done })[state];
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
    this.scrollX = 0;
    this.panning = false;
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

  panTo(x, width, maxX) {
    const thumb = (this.viewW * this.viewW) / width;
    return Math.max(0, Math.min(maxX, ((x - thumb / 2) / this.viewW) * width));
  }

  panBar(t, width, maxX) {
    const thumb = Math.max(24, (this.viewW * this.viewW) / width);
    const at = (this.scrollX / maxX) * (this.viewW - thumb);
    return div().id("wg-pan-bar").relative().flex_none().w_full().h(12).border_t(1).border_color(t.border).cursor_pointer()
      .on_mouse_down("left", (e, cx) => {
        this.panning = true;
        this.scrollX = this.panTo(e.local_position?.x ?? 0, width, maxX);
        cx.notify();
      })
      .child(div().absolute().top(3).left(at).w(thumb).h(6).rounded_full().bg(this.panning ? t.muted : t.border).hover((el) => el.bg(t.muted)));
  }

  setZoom(cx, z) {
    this.zoom = z;
    localStorage.setItem("zoom", String(z));
    cx.notify();
  }

  // One icon per status: a spinner works, ! needs you, a lock is blocked, a hollow dot is idle,
  // a green ring can start, a check is done
  icon(t, state, size) {
    const box = h_flex().flex_none().w(size).h(size).items_center().justify_center();
    const c = color(t, state);
    if (state === "flight") return box.child(svg(SPINNER).size(size * 0.8).text_color(c).spin(900));
    if (state === "needs") return box.child(div().text_size(size * 1.05).font_bold().text_color(c).child("!"));
    if (state === "blocked") return box.child(svg(LOCK).size(size * 0.85).text_color(c));
    if (state === "done") return box.child(div().text_size(size * 0.9).text_color(c).child("✓"));
    return box.child(div().size(size * 0.55).rounded_full().border_1().border_color(c));
  }

  counts(t, counts, size, gap) {
    return h_flex().flex_none().gap(gap).items_center().whitespace_nowrap()
      .children(STATES.filter((s) => counts[s]).map((s) => h_flex().flex_none().gap(size * 0.2).items_center()
        .child(this.icon(t, s, size))
        .child(div().text_size(size * 0.95).text_color(s === "done" || s === "idle" ? t.dim : t.muted).child(String(counts[s])))));
  }

  tip(n) {
    const status = {
      needs: () => `Needs you: ${n.waiting.map((a) => a.id).join(", ")}`,
      flight: () => `Working${n.owner ? `: ${n.owner}` : ""}`,
      idle: () => `Owned, ${SESSION[n.session?.status] ?? "idle"}${n.owner ? `: ${n.owner}` : ""}`,
      blocked: () => `Blocked by ${n.blockers.map((b) => b.id).join(", ")}`,
      ready: () => "Ready to start",
      done: () => (n.issue?.stateName === "Canceled" ? "Canceled" : n.live?.state === "MERGED" ? "Merged" : "Done"),
    };
    const lines = [`${n.title}${n.tag ? ` · ${n.tag}` : " · no kind set"}`];
    if (n.fullTitle && n.fullTitle !== n.title) lines.push(n.fullTitle);
    if (n.kind !== "project") lines.push([n.id, n.pr && n.pr !== n.id ? n.pr : null].filter(Boolean).join(" · "));
    lines.push(n.children.length ? countsText(n.counts) : status[n.state]());
    if (n.owner && !["flight", "idle"].includes(n.state)) lines.push(`Owner: ${n.owner}${n.session ? `, ${SESSION[n.session.status] ?? "idle"}` : ", no live session"}`);
    if (n.blockers.length && n.state !== "blocked") lines.push(`Waits on ${n.blockers.map((b) => b.id).join(", ")}`);
    if (n.issue?.stateName) lines.push(`Linear: ${n.issue.stateName}`);
    if (n.live) lines.push(`${n.pr}: ${n.live.state === "OPEN" && n.live.draft ? "draft" : n.live.state.toLowerCase()}`);
    if (n.kind === "project" && n.info.next) lines.push(`Next: ${String(n.info.next).slice(0, 240)}`);
    if (n.note) lines.push(String(n.note).slice(0, 300));
    if (n.issue && n.live) lines.push("Click opens the issue, Cmd-click the PR");
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

  // A title of a word or two and its kind, then a short summary on one line: words that don't fit
  // wrap onto a hidden line, so none is cut. The status is the icon and the card's colour.
  card(t, n, x, y, u) {
    const group = n.children.length > 0;
    const edge = { flight: t.accent, needs: t.working, ready: t.ansi2 }[n.state] ?? t.border;
    const words = String(n.summary ?? "").split(/\s+/).filter(Boolean);
    return v_flex().id(`wg-${n.key}`).absolute().left(x).top(y).w(u(CARD_W)).h(u(CARD_H)).px(u(10)).py(u(7)).gap(u(4)).justify_center().rounded(u(8))
      .bg(group ? t.raised : t.surface).border_1().border_color(edge).when(n.state === "done", (el) => el.opacity(0.55))
      .cursor_pointer().hover((el) => el.bg(t.hover)).tooltip(this.tip(n))
      .on_click((e, cx) => {
        if (e.modifiers?.platform && n.live?.url) openTarget(n.live.url);
        else if (n.link) openTarget(n.link);
        else if (group) this.toggle(cx, n);
      })
      .when(n.state === "blocked", (el) => el.child(div().absolute().left(0).top(u(10)).w(u(3)).h(u(CARD_H - 20)).rounded_full().bg(t.blocked)))
      .child(h_flex().w_full().h(u(16)).gap(u(6)).items_center().whitespace_nowrap()
        .when(group, (el) => el.child(this.chevron(t, n, u)))
        .child(this.icon(t, n.state, u(13)))
        .child(div().min_w(0).truncate().text_size(u(13)).font_semibold().text_color(n.state === "done" ? t.dim : t.foreground).child(n.title))
        .child(div().flex_1().min_w(0))
        .child(n.tag
          ? div().flex_none().px(u(5)).h(u(15)).flex().items_center().rounded(u(4)).border_1().border_color(t.border).text_size(u(10)).text_color(t.muted).child(n.tag)
          : div().flex_none().text_size(u(11)).text_color(t.dim).opacity(0.6).child("?")))
      .when(words.length > 0, (el) => el.child(h_flex().w_full().h(u(16)).flex_wrap().gap_x(u(4)).overflow_hidden()
        .text_size(u(11.5)).text_color(n.state === "done" ? t.dim : t.muted).children(words.map((w) => div().flex_none().h(u(16)).child(w)))))
      .when(group, (el) => el.child(this.counts(t, n.counts, u(10), u(8))));
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
        .child(this.counts(t, n.counts, u(10), u(7))),
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

  canvas(t, model, vis, lay, u) {
    const lanes = lay.lanes.map((l) => {
      const n = model.nodes.get(l.key);
      return div().absolute().left(0).top(u(l.y)).w(u(lay.width)).h(u(l.h)).border_t(1).border_color(t.border)
        .when(l.open, (el) => el.child(h_flex().id(`wg-lane-${n.key}`).absolute().left(u(PAD - 4)).top(u(5)).h(u(LANE_HEAD - 10)).gap(u(6)).px(u(4))
          .items_center().whitespace_nowrap().rounded(u(4)).cursor_pointer().hover((el) => el.bg(t.hover)).tooltip(this.tip(n))
          .on_click((_e, cx) => this.toggle(cx, n))
          .child(svg(CHEVRON(true)).flex_none().size(u(10)).text_color(t.muted))
          .child(div().flex_none().text_size(u(12.5)).font_semibold().text_color(t.foreground).child(n.title))
          .child(this.counts(t, n.counts, u(11), u(8)))));
    });
    const frames = [...lay.boxes].flatMap(([key, box]) => this.frame(t, model.nodes.get(key), box, u));
    return div().relative().flex_none().w(u(lay.width)).h(u(lay.height))
      .children(lanes)
      .children(this.edges(t, model, vis, lay, u))
      .children(frames)
      .children(vis.cards.map((k) => this.card(t, model.nodes.get(k), u(lay.pos.get(k).x), u(lay.pos.get(k).y), u)));
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
        .child(this.counts(t, counts, 14, 12))
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
          .tooltip(this.tip(n)).on_click(() => openTarget(n.link)).child(n.title)))
        .when(ready.length > 8, (el) => el.child(div().text_color(t.dim).child(`+${ready.length - 8} more`))));
  }

  render() {
    const t = theme();
    const root = v_flex().id("work-graph").size_full().min_h(0).overflow_hidden().bg(t.canvas).text_color(t.foreground);
    if (!this.loaded) return root.child(div().p(PAD).text_color(t.dim).child("Reading the projects."));
    if (!this.projects.length) return root.child(div().p(PAD).text_color(t.dim).child(`No open projects in ${this.folder}.`));
    const sessions = liveSessions(terminals(), spaces());
    const model = build({ projects: this.projects, graphs: this.graphs, issues: this.issues, prs: this.prs, asks: openAsks(this.files), sessions });
    const vis = visible(model, (n) => this.isOpen(n));
    const lay = layout(model, vis);
    const z = this.zoom !== "fit" ? Number(this.zoom) || 1 : this.viewW ? Math.max(MIN_FIT, Math.min(1, this.viewW / lay.width)) : 1;
    const u = (x) => Math.round(x * z * 10) / 10;
    const width = u(lay.width);
    const maxX = Math.max(0, width - this.viewW);
    this.scrollX = Math.min(this.scrollX, maxX);
    return root
      .on_mouse_move((e, cx) => {
        if (!this.panning) return;
        this.scrollX = this.panTo(e.local_position.x, width, maxX);
        cx.notify();
      })
      .on_mouse_up("left", () => (this.panning = false))
      .child(this.summary(t, model, z))
      // A native scroller on both axes, or one nested in another, never moves down here, so the
      // view scrolls natively down and pans across by hand: a sideways swipe or shift-wheel moves
      // it, and so does the bar below
      .child(div().id("wg-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .on_size_change((size, cx) => {
          if (Math.abs(size.width - this.viewW) < 1) return;
          this.viewW = size.width;
          cx.notify();
        })
        .child(div().id("wg-pan").relative().w_full().flex_none().h(u(lay.height)).overflow_hidden()
          .on_scroll_wheel((e, cx) => {
            if (Math.abs(e.delta.x) <= Math.abs(e.delta.y) || maxX <= 0) return;
            cx.stop_propagation();
            this.scrollX = Math.max(0, Math.min(maxX, this.scrollX - e.delta.x));
            cx.notify();
          })
          .child(this.canvas(t, model, vis, lay, u).absolute().top(0).left(-this.scrollX))))
      .when(maxX > 0, (el) => el.child(this.panBar(t, width, maxX)));
  }
}
