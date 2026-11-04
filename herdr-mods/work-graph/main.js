// All tracked work as a DAG that zooms: a lane per open project, and inside it the project's
// nodes nested by parent (see graph.js). A collapsed node is one card that rolls up the status of
// everything in it; an expanded one is a frame around its children. Arrows run from each blocker
// to what it blocks, combined between collapsed cards into one thicker arrow, in columns by
// dependency depth among what shows. A leaf is done, needs you (an open ask names it), in flight
// (its owner session is working), waiting (its owner is between turns with a background job or a
// wake set), blocked (a blocker isn't done), owned but idle (its owner is live with nothing
// pending), or ready: nothing blocks it and nobody owns it.
//
// The level buttons expand everything above that depth (0: projects only); clicking a card that
// has children opens it, and clicking a frame's header closes it. Resting the pointer on a card
// fades everything not on its path: what it waits on and what waits on it, inside its lane.
// A warning marks a card whose graph file contradicts itself: a blocker in another lane, work
// started or finished before its blockers are done, or a blocker that holds or sits inside the
// node; a collapsed card shows it for anything inside.
// Its i icon shows its details and a labelled link for each place it can be opened; a file opens
// in this mod's own read-only viewer, split beside it. Cmd with scroll zooms around the pointer.
// Commands work-graph.level0 to level3 and work-graph.refresh do the same from a key or a script. props or ~/.config/herdr-app/work-graph.json
// give { folder }, the projects folder of state files, and { records }, the folder where each agent
// process keeps <pid>.json with its status (~/.claude/sessions unless set).

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, HoverCard, TextView, Editor, EditorState } from "gpui-base";
import { exec, run, theme, props, terminals, spaces, watchFolder, readTextFile, home, nextCommand, settings } from "herdr";
import { expand, readFiles, projectList, readGraph, linearIds, fetchLinear, prRefs, fetchPrs, openAsks, liveSessions, readRecords, rootProject, build, visible, pathOf, STATES } from "./graph.js";

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
// Cmd and scroll zoom between these, by this much per pixel scrolled
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const ZOOM_RATE = 0.004;
// How much of the graph stays in the pane however a zoom leaves it
const LOOSE = 48;
const LEVELS = [0, 1, 2, 3];
const SPINNER = "mods/work-graph/spinner.svg";
const ANIM_MS = 300;
const EASE = { duration: ANIM_MS, easing: "ease-in-out" };
// Each element moves natively from where it last drew to where it draws now
const moves = (el) => el.transition("left", EASE).transition("top", EASE).transition("width", EASE).transition("height", EASE).transition("opacity", EASE);
const LOCK = "mods/work-graph/lock.svg";
const CLOCK = "mods/work-graph/clock.svg";
const WARN = "mods/work-graph/warn.svg";
const CHEVRON = (open) => `mods/work-graph/chevron-${open ? "down" : "right"}.svg`;
const INFO = "mods/work-graph/info.svg";
// What isn't on the hovered node's path fades to this, quickly
const DIM = 0.3;
const FADE = { duration: 150, easing: "ease-in-out" };

// A path with a rounded corner at each bend and an arrowhead at its end
function trace(st, pts, tip, radius, head) {
  st.line.move_to(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx0, cy0] = pts[i];
    const [nx, ny] = pts[i + 1];
    const din = Math.hypot(cx0 - px, cy0 - py);
    const dout = Math.hypot(nx - cx0, ny - cy0);
    const rr = Math.min(radius, din / 2, dout / 2);
    st.line.line_to(cx0 - ((cx0 - px) / din) * rr, cy0 - ((cy0 - py) / din) * rr)
      .curve_to(cx0 + ((nx - cx0) / dout) * rr, cy0 + ((ny - cy0) / dout) * rr, cx0, cy0);
  }
  const [lx, ly] = pts[pts.length - 1];
  st.line.line_to(lx, ly);
  st.heads.add_polygon([[lx, ly - head], [tip, ly], [lx, ly + head]], true);
}

const WORD = { needs: ["needs you", "need you"], ready: ["ready"], flight: ["in flight"], waiting: ["waiting"], idle: ["owned, idle"], blocked: ["blocked"], done: ["done"] };
const word = (s, k) => (k === 1 ? WORD[s][0] : WORD[s][1] ?? WORD[s][0]);
const SESSION = { working: "working", blocked: "waiting on a dialog", waiting: "waiting on a background job or a wake" };
const color = (t, state) => ({ needs: t.working, ready: t.ansi2, flight: t.accent, waiting: t.accent, idle: t.dim, blocked: t.blocked, done: t.done })[state];
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

const LINK = (name) => `mods/work-graph/link-${name}.svg`;
const isUrl = (s) => /^https?:\/\//.test(s ?? "");
const URLS = /https?:\/\/[^\s)>"\]]+/g;
const base = (path) => String(path).replace(/\/+$/, "").split("/").pop();

// A link's icon and a label that names its target, from the URL or path alone
function classify(target, label) {
  if (!isUrl(target)) return { icon: "file", label: label ?? `File ${base(target)}`, file: expand(target) };
  let u;
  try {
    u = new URL(target);
  } catch {
    return { icon: "web", label: label ?? target, url: target };
  }
  const tail = base(u.pathname) || u.hostname;
  const pr = /\/pull\/(\d+)/.exec(u.pathname);
  if (u.hostname.endsWith("github.com") && pr) return { icon: "pr", label: label ?? `PR #${pr[1]}`, url: target };
  if (u.hostname.endsWith("linear.app")) return { icon: "issue", label: label ?? `Linear ${/[A-Z][A-Z0-9]*-\d+/i.exec(u.pathname)?.[0]?.toUpperCase() ?? tail}`, url: target };
  if (u.hostname.endsWith("slack.com")) return { icon: "chat", label: label ?? "Slack thread", url: target };
  return { icon: /report|run|test/i.test(label ?? "") ? "report" : "web", label: label ?? `${u.hostname.split(".")[0]} ${tail}`, url: target };
}

// Every place a node can be opened: its issue, its PR and the PRs next to it in a stack, the
// graph file's own links and any URL in its note, and its owner session's pane
function linksOf(n, model, sessions) {
  const out = [];
  const seen = new Set();
  const add = (l) => {
    const key = l.url ?? l.file ?? l.terminal;
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(l);
    }
  };
  if (n.issue?.url) add({ icon: "issue", label: `Linear ${n.id}`, url: n.issue.url });
  if (n.pr) {
    const number = n.pr.split("#")[1];
    add({ icon: "pr", label: `PR #${number}${n.live?.draft ? ", draft" : ""}`, url: n.live?.url ?? `https://github.com/${n.pr.replace("#", "/pull/")}` });
    const repo = n.pr.split("#")[0];
    const others = [...model.nodes.values()].filter((m) => m !== n && m.live && m.pr?.split("#")[0] === repo);
    const below = n.live?.base ? others.find((m) => m.live.head === n.live.base) : null;
    const above = n.live?.head ? others.find((m) => m.live.base === n.live.head) : null;
    if (below) add({ icon: "stack", label: `Stacked on PR #${below.pr.split("#")[1]}`, url: below.live.url });
    if (above) add({ icon: "stack", label: `Next in stack PR #${above.pr.split("#")[1]}`, url: above.live.url });
  }
  for (const l of Array.isArray(n.raw.links) ? n.raw.links : []) if (l?.url) add(classify(l.url, l.label));
  if (n.raw.link) add(classify(n.raw.link));
  for (const u of String(n.note ?? "").match(URLS) ?? []) add(classify(u));
  const owner = n.kind === "project" ? n.info.lead : n.owner;
  const live = owner ? sessions.byName.get(owner) : null;
  if (live) add({ icon: "session", label: `Session ${owner}`, terminal: live.address });
  return out;
}

function follow(link) {
  if (link.url) exec("open", [link.url]);
  else if (link.terminal) run("pane.focus", { terminal: link.terminal });
  else if (link.file) run("pane.split", { direction: "right", mod: "work-graph", props: { mode: "file", path: link.file } });
}

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
        // File order, not order by blocker, so opening one node moves the others as little as possible
        list.sort((a, b) => order.get(a) - order.get(b)).forEach((k, i) => pos.set(k, { x: colX(c), y: y + i * (CARD_H + GAP_Y) }));
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
    if (props()?.mode === "file") return this.initFile(cx);
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
    this.viewH = 0;
    this.scrollX = 0;
    this.scrollY = 0;
    this.drag = null;
    this.anim = null;
    this.last = null;
    this.error = null;
    this.busy = false;
    this.loaded = false;
    this.records = new Map();
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
    // Agent records change on every turn, so only a change of some agent's status redraws
    cx.spawn(async (cx) => {
      const folder = expand(props()?.records ?? (await readConfig()).records ?? "~/.claude/sessions");
      for (;;) {
        const records = await readRecords(folder);
        const sig = (m) => [...m].sort((a, b) => a[0] - b[0]).join();
        if (sig(records) !== sig(this.records)) {
          this.records = records;
          cx.notify();
        }
        try {
          await watchFolder(folder);
        } catch {
          await new Promise((r) => cx.timer.after(30000, () => r()));
        }
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

  // A file opened from a link, read only: Markdown rendered, anything else in a read-only editor
  initFile(cx) {
    this.viewer = { path: props().path, text: null, error: null, code: null };
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.viewer.path);
        if (text == null) this.viewer.error = "This file is no longer there.";
        else if (text.includes("\0")) this.viewer.error = "Binary file, no preview.";
        else {
          this.viewer.text = text.length > 400000 ? `${text.slice(0, 400000)}\n… (cut at 400,000 characters)` : text;
          if (!/\.(md|markdown)$/i.test(this.viewer.path)) {
            const ext = this.viewer.path.includes(".") ? this.viewer.path.split(".").pop() : "txt";
            this.viewer.code = EditorState.new({ language: ext, readonly: true, value: this.viewer.text, font_family: settings().font_family, font_size: 12 });
          }
        }
      } catch (e) {
        this.viewer.error = `Could not read it: ${e?.message ?? e}`;
      }
      cx.notify();
    });
  }

  fileView(t) {
    const v = this.viewer;
    const body = v.error ? div().p(PAD).text_color(t.blocked).child(v.error)
      : v.code ? Editor.new(v.code).flex_1().min_h(0)
      : v.text != null ? div().id("wg-file").flex_1().min_h(0).overflow_y_scrollbar().px(PAD).py(10)
        .child(TextView.markdown("wg-file-md", v.text).selectable(true).text_size(13).text_color(t.foreground))
      : div().p(PAD).text_color(t.dim).child("Reading the file.");
    return v_flex().id("work-graph-file").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(30).px(PAD).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(LINK("file")).size(12).text_color(t.muted))
        .child(div().flex_none().text_size(12.5).font_semibold().child(base(v.path)))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(v.path.replace(home(), "~"))))
      .child(body);
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
    // The card under the pointer becomes a frame, which never reports the pointer leaving it
    this.hoverCard = null;
    this.hoverPop = null;
    this.animate(cx, n.key);
    this.open.set(n.key, !this.isOpen(n));
    localStorage.setItem("open", JSON.stringify(Object.fromEntries(this.open)));
    cx.notify();
  }

  // Back inside the graph's bounds, wherever a zoom left it
  home() {
    this.loose = false;
  }

  // A level resets every node opened or closed by hand
  setLevel(cx, level) {
    this.home();
    this.animate(cx, null);
    this.level = level;
    this.open = new Map();
    localStorage.setItem("level", String(level));
    localStorage.setItem("open", "{}");
    cx.notify();
  }

  // A change of what shows plays in three frames: the next render keeps everything where it
  // was, with new nodes waiting faded inside the card they come out of and leaving ones still in
  // place; 40 ms later every element is given its new place and moves there natively; once that
  // is over, the leaving ones are dropped and the arrows come back
  animate(cx, anchor) {
    const token = (this.anim?.token ?? 0) + 1;
    this.anim = { token, anchor, phase: 0, built: false, enter: new Map(), ghosts: [], dx: 0, dy: 0 };
    cx.timer.after(40, (cx) => {
      if (this.anim?.token !== token) return;
      this.anim.phase = 1;
      this.scrollX += this.anim.dx;
      this.scrollY += this.anim.dy;
      cx.notify();
    });
    cx.timer.after(40 + ANIM_MS + 40, (cx) => {
      if (this.anim?.token !== token) return;
      this.anim = null;
      cx.notify();
    });
  }

  // Where each new element comes from and where each leaving one goes: into or out of the card
  // nearest above it on the other side of the change, or between a node's card and its frame
  buildAnim(model, rects) {
    const a = this.anim;
    a.built = true;
    const old = this.last ?? new Map();
    const up = (key) => [key, ...(model.nodes.get(key)?.ancestors ?? [])];
    for (const [id, r] of rects) {
      if (old.has(id) || r.kind === "lane") continue;
      const own = old.get(`f:${r.key}`);
      if (r.kind === "card" && own) {
        a.enter.set(id, { ...own, fade: false });
        continue;
      }
      const card = up(r.key).map((k) => old.get(`c:${k}`)).find(Boolean);
      if (card) a.enter.set(id, { ...card, fade: !(r.kind === "frame" && card === old.get(`c:${r.key}`)) });
    }
    for (const [id, r] of old) {
      if (rects.has(id) || r.kind === "lane" || !model.nodes.has(r.key)) continue;
      const own = r.kind === "frame" ? rects.get(`c:${r.key}`) : null;
      const to = own ?? up(r.key).map((k) => rects.get(`c:${k}`)).find(Boolean);
      if (to) a.ghosts.push({ id, key: r.key, kind: r.kind, from: r, to });
    }
    if (a.anchor) {
      const before = old.get(`c:${a.anchor}`) ?? old.get(`f:${a.anchor}`) ?? old.get(`l:${a.anchor}`);
      const after = rects.get(`f:${a.anchor}`) ?? rects.get(`c:${a.anchor}`) ?? rects.get(`l:${a.anchor}`);
      if (before && after) {
        a.dx = after.x - before.x;
        a.dy = after.y - before.y;
      }
    }
  }

  place(id, target) {
    const a = this.anim;
    if (!a?.built || a.phase > 0) return { ...target, o: 1 };
    const old = this.last?.get(id);
    if (old) return { ...old, o: 1 };
    const from = a.enter.get(id);
    return from ? { ...from, o: from.fade ? 0 : 1 } : { ...target, o: 1 };
  }

  bar(t, axis, size, max) {
    const view = axis === "y" ? this.viewH : this.viewW;
    const thumb = Math.max(24, (view * view) / size);
    const at = Math.max(0, Math.min(1, (axis === "y" ? this.scrollY : this.scrollX) / max)) * (view - thumb);
    const grab = (e, cx) => {
      this.drag = { axis, from: axis === "y" ? e.position.y : e.position.x, start: axis === "y" ? this.scrollY : this.scrollX, per: size / view };
      cx.notify();
    };
    const tone = this.drag?.axis === axis ? t.muted : t.border;
    return axis === "y"
      ? div().id("wg-vbar").absolute().top(0).right(0).w(12).h_full().on_mouse_down("left", grab)
        .child(div().absolute().right(3).top(at).w(6).h(thumb).rounded_full().bg(tone).hover((el) => el.bg(t.muted)))
      : div().id("wg-hbar").relative().flex_none().w_full().h(12).border_t(1).border_color(t.border).on_mouse_down("left", grab)
        .child(div().absolute().top(3).left(at).w(thumb).h(6).rounded_full().bg(tone).hover((el) => el.bg(t.muted)));
  }

  setZoom(cx, z) {
    if (z === "fit") this.home();
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
    if (state === "waiting") return box.child(svg(CLOCK).size(size * 0.85).text_color(c));
    if (state === "done") return box.child(div().text_size(size * 0.9).text_color(c).child("✓"));
    return box.child(div().size(size * 0.55).rounded_full().border_1().border_color(c));
  }

  counts(t, counts, size, gap) {
    return h_flex().flex_none().gap(gap).items_center().whitespace_nowrap()
      .children(STATES.filter((s) => counts[s]).map((s) => h_flex().flex_none().gap(size * 0.2).items_center()
        .child(this.icon(t, s, size))
        .child(div().text_size(size * 0.95).text_color(s === "done" || s === "idle" ? t.dim : t.muted).child(String(counts[s])))));
  }

  statusLine(n) {
    if (n.children.length) return null;
    return {
      needs: `Needs you: ${n.waiting.map((a) => a.id).join(", ")}`,
      flight: "Working",
      waiting: `Owned, ${SESSION.waiting}`,
      idle: `Owned, ${SESSION[n.session?.status] ?? "idle"}`,
      blocked: "Blocked",
      ready: "Ready to start",
      done: n.issue?.stateName === "Canceled" ? "Canceled" : n.live?.state === "MERGED" ? "Merged" : "Done",
    }[n.state];
  }

  // What a card holds that it doesn't show: the full title, owner, status, blockers, state in
  // Linear and GitHub, the note, and a labelled link for every place it can be opened
  popup(t, n) {
    const links = linksOf(n, this.model, this.sessions);
    const owner = n.kind === "project" ? n.info.lead : n.owner;
    const ownerState = owner ? (n.kind === "project" ? this.sessions.byName.get(owner) : n.session) : null;
    const row = (label, value, tone) => h_flex().gap(8).items_start().text_size(12)
      .child(div().flex_none().w(64).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).whitespace_normal().text_color(tone ?? t.foreground).child(value));
    return v_flex().id(`wg-pop-${n.key}`).w(340).p(12).gap(8).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_color(t.foreground)
      .on_hover((on, cx) => {
        if (on) this.hoverPop = n.key;
        else if (this.hoverPop === n.key) this.hoverPop = null;
        cx.notify();
      })
      .child(h_flex().gap(8).items_center()
        .child(this.icon(t, n.state, 14))
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(n.title))
        .child(div().flex_none().px(6).h(17).flex().items_center().rounded(4).border_1().border_color(t.border).text_size(10.5)
          .text_color(n.tag ? t.muted : t.dim).child(n.tag ?? "no kind")))
      .when(Boolean(n.fullTitle && n.fullTitle !== n.title), (el) => el.child(div().text_size(12.5).text_color(t.muted).whitespace_normal().child(n.fullTitle)))
      .child(v_flex().gap(3)
        .when(n.kind !== "project", (el) => el.child(row("Id", [n.id, n.pr && n.pr !== n.id ? n.pr : null].filter(Boolean).join(" · "))))
        .when(Boolean(this.statusLine(n)), (el) => el.child(row("Status", this.statusLine(n), color(t, n.state))))
        .when(n.children.length > 0, (el) => el.child(h_flex().gap(8).items_center().text_size(12)
          .child(div().flex_none().w(64).text_color(t.dim).child("Inside")).child(this.counts(t, n.counts, 12, 10))))
        .when(Boolean(owner), (el) => el.child(row("Owner", `${owner}${ownerState ? `, ${SESSION[ownerState.status] ?? "idle"}` : ", no live session"}`)))
        .when(n.blockers.length > 0, (el) => el.child(row("Waits on", n.blockers.map((b) => b.title === b.id ? b.id : `${b.title} (${b.id})`).join(", "), t.muted)))
        .when(Boolean(n.issue?.stateName), (el) => el.child(row("Linear", n.issue.stateName)))
        .when(Boolean(n.live), (el) => el.child(row("PR", n.live.state === "OPEN" && n.live.draft ? "draft" : n.live.state.toLowerCase())))
        .when(n.kind === "project" && Boolean(n.info.next), (el) => el.child(row("Next", String(n.info.next).slice(0, 220), t.muted))))
      .when(Boolean(n.note), (el) => el.child(div().text_size(11.5).text_color(t.dim).whitespace_normal().child(String(n.note).replace(URLS, "").slice(0, 280))))
      .when(Boolean(n.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).whitespace_normal().child(n.error)))
      .when(n.flagged.length > 0, (el) => el.child(v_flex().gap(3).text_size(11.5).whitespace_normal()
        .child(h_flex().gap(6).items_center().text_color(t.working).child(svg(WARN).flex_none().size(12)).child("Check the graph file"))
        .children(n.flagged.slice(0, 6).flatMap((k) => this.model.nodes.get(k).problems.map((p) =>
          div().text_color(t.foreground).child(k === n.key ? p : `${this.model.nodes.get(k).title}: ${p}`))))
        .when(n.flagged.length > 6, (el) => el.child(div().text_color(t.dim).child(`and ${n.flagged.length - 6} more inside`)))))
      .child(div().h(1).bg(t.border))
      .child(links.length
        ? v_flex().gap(1).children(links.map((l, i) => h_flex().id(`wg-link-${n.key}-${i}`).h(24).px(6).gap(8).items_center().rounded(5)
          .cursor_pointer().hover((el) => el.bg(t.hover)).on_click(() => follow(l))
          .child(svg(LINK(l.icon)).flex_none().size(13).text_color(t.muted))
          .child(div().min_w(0).truncate().text_size(12.5).text_color(t.accent).child(l.label))))
        : div().text_size(12).text_color(t.dim).child("No links. Add some under links in the graph file."));
  }

  // A trigger that opens the node's popup when the pointer rests on it, and keeps it open while
  // the pointer moves into it
  hover(id, n, trigger) {
    return HoverCard.new(id).open_delay(350).close_delay(250).anchor("top_left").trigger(trigger).content(this.popup(theme(), n));
  }

  // The node's details and links open from this icon alone, so a click anywhere else on the card
  // is free to open or close it
  info(t, n, u, id) {
    return this.hover(id, n, div().id(`${id}-i`).flex_none().size(u(16)).flex().items_center().justify_center().rounded_full()
      .text_color(t.dim).hover((el) => el.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => cx.stop_propagation())
      .child(svg(INFO).size(u(12))));
  }

  pointAt(key) {
    return (on, cx) => {
      if (on) this.hoverCard = key;
      else if (this.hoverCard === key) this.hoverCard = null;
      cx.notify();
    };
  }

  dims(key) {
    return this.path != null && !this.path.lit.has(key);
  }

  chevron(t, n, u) {
    return div().flex_none().size(u(14)).flex().items_center().justify_center().text_color(t.muted)
      .child(svg(CHEVRON(this.isOpen(n))).size(u(10)));
  }

  // A title of a word or two and its kind, then a short summary on one line: words that don't fit
  // wrap onto a hidden line, so none is cut. The status is the icon and the card's colour; a done
  // card, or a collapsed one with everything in it done, has a green border and stays at full
  // strength, since fading means only "off the hovered path"
  card(t, n, r, u) {
    const group = n.children.length > 0;
    const edge = { flight: t.accent, needs: t.working, ready: t.ansi2, done: t.ansi2 }[n.state] ?? t.border;
    const words = String(n.summary ?? "").split(/\s+/).filter(Boolean);
    const face = v_flex().id(`wg-${n.key}`).relative().size_full().px(u(10)).py(u(7)).gap(u(4)).justify_center().rounded(u(8))
      .bg(group ? t.raised : t.surface).border_1().border_color(edge)
      .opacity(this.dims(n.key) ? DIM : 1).transition("opacity", FADE)
      .hover((el) => el.bg(t.hover))
      .when(group, (el) => el.cursor_pointer().on_click((_e, cx) => this.toggle(cx, n)))
      .on_hover(this.pointAt(n.key))
      .when(n.state === "blocked", (el) => el.child(div().absolute().left(0).top(u(10)).w(u(3)).h(u(CARD_H - 20)).rounded_full().bg(t.blocked)))
      .child(h_flex().w_full().h(u(16)).gap(u(6)).items_center().whitespace_nowrap()
        .when(group, (el) => el.child(this.chevron(t, n, u)))
        .child(this.icon(t, n.state, u(13)))
        .child(div().min_w(0).truncate().text_size(u(13)).font_semibold().text_color(t.foreground).child(n.title))
        .child(div().flex_1().min_w(0))
        .child(n.tag
          ? div().flex_none().px(u(5)).h(u(15)).flex().items_center().rounded(u(4)).border_1().border_color(t.border).text_size(u(10)).text_color(t.muted).child(n.tag)
          : div().flex_none().text_size(u(11)).text_color(t.dim).opacity(0.6).child("?")))
      .when(words.length > 0, (el) => el.child(h_flex().w_full().h(u(16)).flex_wrap().gap_x(u(4)).overflow_hidden()
        .text_size(u(11.5)).text_color(t.muted).children(words.map((w) => div().flex_none().h(u(16)).child(w)))))
      .when(group, (el) => el.child(this.counts(t, n.counts, u(10), u(8))))
      .when(n.flagged.length > 0, (el) => el.child(div().absolute().right(u(23)).bottom(u(6)).child(svg(WARN).size(u(12)).text_color(t.working))))
      .child(div().absolute().right(u(5)).bottom(u(4)).child(this.info(t, n, u, `wg-hc-${n.key}`)));
    return moves(div().id(`wg-pos-${n.key}`).absolute().left(r.x).top(r.y).w(r.w).h(r.h).opacity(r.o)).child(face);
  }

  // A frame around an expanded node's children, its header the handle that closes it. Frames
  // draw over the arrows, so the header hides an arrow passing under it.
  frameBox(t, n, r, u) {
    return moves(div().id(`wg-box-${n.key}`).absolute().left(r.x).top(r.y).w(r.w).h(r.h).opacity(r.o))
      .child(div().id(`wg-line-${n.key}`).size_full().rounded(u(10)).border_1().border_color(t.border).opacity(this.dims(n.key) ? DIM : 1).transition("opacity", FADE));
  }

  frameHead(t, n, r, u) {
    return moves(div().id(`wg-fh-${n.key}`).absolute().left(r.x + u(6)).top(r.y + u(4)).w(Math.max(0, r.w - u(12))).h(u(GROUP_HEAD - 6)).opacity(r.o)).overflow_hidden()
      .child(h_flex().id(`wg-frame-${n.key}`).h_full().gap(u(6)).px(u(4)).items_center().whitespace_nowrap().rounded(u(4)).bg(t.canvas)
        .opacity(this.dims(n.key) ? DIM : 1).transition("opacity", FADE)
        .cursor_pointer().hover((el) => el.bg(t.hover)).on_click((_e, cx) => this.toggle(cx, n)).on_hover(this.pointAt(n.key))
        .child(svg(CHEVRON(true)).flex_none().size(u(10)).text_color(t.muted))
        .child(div().flex_none().text_size(u(11.5)).font_semibold().text_color(t.foreground).child(n.title))
        .child(this.counts(t, n.counts, u(10), u(7)))
        .when(n.flagged.length > 0, (el) => el.child(svg(WARN).flex_none().size(u(11)).text_color(t.working)))
        .child(this.info(t, n, u, `wg-hf-${n.key}`)));
  }

  // Arrows run in the gaps: out of a card's right side into the gutter after its column, along a
  // free strip between rows or lanes when the target is further right, down the gutter before
  // the target's column, and in. Unscaled pixels, worked out once per layout.
  routes(model, vis, lay) {
    const sig = `${lay.width}|${lay.height}|${vis.cards.join()}|${vis.edges.map((e) => e.key).join()}`;
    if (this.routed?.sig === sig) return this.routed.list;
    const rect = (key) => {
      const p = lay.pos.get(key);
      if (p) return { x: p.x, y: p.y, w: CARD_W, h: CARD_H };
      const b = lay.boxes.get(key);
      // An arrow into or out of a frame meets its header, so it can't be mistaken for one into
      // the card beside the frame's middle
      if (b) return { x: b.x, y: b.y, w: b.w, h: GROUP_HEAD };
      const lane = lay.lanes.find((l) => l.key === key);
      return { x: lay.left, y: lane.y, w: lay.width - lay.left, h: LANE_HEAD };
    };
    const pitch = CARD_W + GAP_X;
    const gutter = (k) => lay.left + k * pitch + CARD_W + GAP_X / 2;
    const after = (x) => gutter(Math.max(0, Math.ceil((x + 2 - lay.left - CARD_W - GAP_X / 2) / pitch)));
    const before = (x) => gutter(Math.floor((x - 2 - lay.left - CARD_W - GAP_X / 2) / pitch));
    // A strip runs clear of every card and every frame's header, since arrows draw over them
    const boxes = [...vis.cards.map((k) => rect(k)), ...[...lay.boxes.values()].map((b) => ({ x: b.x, y: b.y, w: b.w, h: GROUP_HEAD }))];
    const strips = [...new Set([
      ...vis.cards.map((k) => rect(k)).flatMap((r) => [r.y - GAP_Y / 2, r.y + r.h + GAP_Y / 2]),
      ...lay.lanes.map((l) => l.y + LANE_HEAD / 2),
    ].map((y) => Math.round(y)))];
    const clear = (y, xa, xb) => !boxes.some((r) => y > r.y - 3 && y < r.y + r.h + 3 && r.x < xb && r.x + r.w > xa);
    const strip = (xa, xb, y1, y2) => strips.filter((y) => clear(y, xa, xb))
      .reduce((best, y) => (best === null || Math.abs(y - y1) + Math.abs(y - y2) < Math.abs(best - y1) + Math.abs(best - y2) ? y : best), null) ?? (y1 + y2) / 2;
    const outs = new Map();
    const ins = new Map();
    for (const e of vis.edges) {
      outs.set(e.from, [...(outs.get(e.from) ?? []), e]);
      ins.set(e.to, [...(ins.get(e.to) ?? []), e]);
    }
    for (const l of outs.values()) l.sort((a, b) => rect(a.to).y - rect(b.to).y);
    for (const l of ins.values()) l.sort((a, b) => rect(a.from).y - rect(b.from).y);
    const spread = (list, e, h) => {
      const step = Math.min(6, Math.max(0, h - 20) / Math.max(1, list.length - 1));
      return (list.indexOf(e) - (list.length - 1) / 2) * step;
    };
    const list = vis.edges.map((e) => {
      const a = rect(e.from);
      const b = rect(e.to);
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2 + spread(outs.get(e.from), e, a.h);
      const x2 = b.x - 6;
      const y2 = b.y + b.h / 2 + spread(ins.get(e.to), e, b.h);
      const gs = after(x1);
      const gt = before(b.x);
      if (gt <= gs + 1 || gs >= x2) {
        const g = gs < x2 - 4 ? gs : (x1 + x2) / 2;
        return { e, tip: b.x, legs: [{ kind: "x", at: y1, from: x1, to: g }, { kind: "y", at: g, from: y1, to: y2 }, { kind: "x", at: y2, from: g, to: x2 }] };
      }
      const yc = strip(gs, gt, y1, y2);
      return { e, tip: b.x, legs: [
        { kind: "x", at: y1, from: x1, to: gs }, { kind: "y", at: gs, from: y1, to: yc }, { kind: "x", at: yc, from: gs, to: gt },
        { kind: "y", at: gt, from: yc, to: y2 }, { kind: "x", at: y2, from: gt, to: x2 },
      ] };
    });
    // Arrows sharing a gutter or a strip run side by side, a few pixels apart, ordered so they
    // cross as little as possible
    const lanesOf = (kind, room) => {
      const groups = new Map();
      for (const r of list) r.legs.forEach((leg, i) => {
        if (leg.kind !== kind || i === 0 || i === r.legs.length - 1) return;
        const k = Math.round(leg.at);
        groups.set(k, [...(groups.get(k) ?? []), { r, i }]);
      });
      for (const g of groups.values()) {
        g.sort((p, q) => Math.min(p.r.legs[p.i].from, p.r.legs[p.i].to) - Math.min(q.r.legs[q.i].from, q.r.legs[q.i].to));
        const step = Math.min(3, room / Math.max(1, g.length));
        g.forEach(({ r, i }, k) => (r.legs[i].off = (k - (g.length - 1) / 2) * step));
      }
    };
    lanesOf("y", GAP_X / 2 - 8);
    lanesOf("x", GAP_Y / 2 - 2);
    for (const r of list) {
      const pts = [];
      r.legs.forEach((leg, i) => {
        const at = leg.at + (leg.off ?? 0);
        const next = r.legs[i + 1];
        if (i === 0) pts.push(leg.kind === "x" ? [leg.from, at] : [at, leg.from]);
        const end = next ? next.at + (next.off ?? 0) : leg.to;
        pts.push(leg.kind === "x" ? [end, at] : [at, end]);
      });
      r.pts = pts.filter((pt, i) => i === 0 || Math.hypot(pt[0] - pts[i - 1][0], pt[1] - pts[i - 1][1]) > 0.5);
    }
    this.routed = { sig, list };
    return list;
  }

  // Paths by look: thicker when one arrow stands for several dependencies, and in the accent colour
  // while the pointer is on the arrow. The hovered card's path is drawn again, plainly, on its own layer, so it can fade in
  // over the rest as they fade out; the last path stays on it while it fades away.
  edges(t, model, vis, lay, u) {
    const looks = (map) => (look, width, tone) => {
      if (!map.has(look)) map.set(look, { tone, line: PathBuilder.stroke(width), heads: PathBuilder.fill() });
      return map.get(look);
    };
    const all = new Map();
    const lit = new Map();
    const style = looks(all);
    const litStyle = looks(lit);
    const path = this.path ?? this.fading;
    const hits = [];
    for (const r of this.routes(model, vis, lay)) {
      const e = r.e;
      const merged = e.list.length > 1;
      const plain = (pick) => pick(`plain${merged}`, 1.5 + (merged ? 1 : 0), t.muted);
      const st = this.hoverEdge?.key === e.key ? style(`hot${merged}`, 1.75 + (merged ? 1 : 0), t.accent)
        : plain(style);
      const pts = r.pts.map(([x, y]) => [u(x), u(y)]);
      trace(st, pts, u(r.tip), u(6), u(4));
      if (path && e.list.some((b) => path.edges.has(`${b.from}>${b.to}`))) trace(plain(litStyle), pts, u(r.tip), u(6), u(4));
      if (this.anim) continue;
      // Paths take no pointer, so small clear targets sit along the route
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 14));
        for (let k = 0; k < steps; k++) {
          const x = ax + ((bx - ax) * (k + 0.5)) / steps;
          const y = ay + ((by - ay) * (k + 0.5)) / steps;
          const dot = `${i}-${k}`;
          hits.push(div().id(`wg-hit-${e.key}-${dot}`).absolute().left(x - 6).top(y - 6).size(12)
            .on_hover((on, cx) => {
              if (on) this.hoverEdge = { key: e.key, dot, x, y, list: e.list };
              else if (this.hoverEdge?.key === e.key && this.hoverEdge.dot === dot) this.hoverEdge = null;
              cx.notify();
            }));
        }
      }
    }
    const paint = (map) => [...map.values()].flatMap((st) => [
      window.paint_path(st.line.build(), st.tone).absolute().top(0).left(0).size_full(),
      window.paint_path(st.heads.build(), st.tone).absolute().top(0).left(0).size_full(),
    ]);
    return { all: paint(all), lit: paint(lit), hits };
  }

  // The dependencies one arrow stands for, one line each, beside the pointer
  edgeNote(t, model) {
    const h = this.hoverEdge;
    if (!h || this.anim) return null;
    const name = (k) => model.nodes.get(k)?.title ?? k;
    const lines = [...new Set(h.list.map((e) => `${name(e.from)} blocks ${name(e.to)}`))];
    return v_flex().absolute().left(h.x + 12).top(h.y + 10).max_w(320).px(9).py(6).gap(2).rounded(7)
      .border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .children(lines.slice(0, 12).map((l) => div().text_size(12).text_color(t.foreground).whitespace_nowrap().child(l)))
      .when(lines.length > 12, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`and ${lines.length - 12} more`)));
  }

  // One order everywhere: lane bands, frame outlines, headers and cards, then every arrow on one
  // layer above them all, so none is ever partly hidden. The arrows' hover targets sit under the
  // cards, which keep the pointer where the two meet.
  canvas(t, model, vis, lay, u, rects) {
    const bands = lay.lanes.map((l) => {
      const r = this.place(`l:${l.key}`, rects.get(`l:${l.key}`));
      return moves(div().id(`wg-band-${l.key}`).absolute().left(0).top(r.y).w(r.w).h(r.h)).border_t(1).border_color(t.border);
    });
    const laneHeads = lay.lanes.filter((l) => l.open).map((l) => {
      const n = model.nodes.get(l.key);
      const r = this.place(`l:${l.key}`, rects.get(`l:${l.key}`));
      return moves(div().id(`wg-lh-${l.key}`).absolute().left(u(PAD - 4)).top(r.y + u(5)).h(u(LANE_HEAD - 10)))
        .child(h_flex().id(`wg-lane-${n.key}`).h_full().gap(u(6)).px(u(4)).items_center().whitespace_nowrap().rounded(u(4)).bg(t.canvas)
          .opacity(this.dims(n.key) ? DIM : 1).transition("opacity", FADE)
          .cursor_pointer().hover((el) => el.bg(t.hover)).on_click((_e, cx) => this.toggle(cx, n)).on_hover(this.pointAt(n.key))
          .child(svg(CHEVRON(true)).flex_none().size(u(10)).text_color(t.muted))
          .child(div().flex_none().text_size(u(12.5)).font_semibold().text_color(t.foreground).child(n.title))
          .child(this.counts(t, n.counts, u(11), u(8)))
          .when(n.flagged.length > 0, (el) => el.child(svg(WARN).flex_none().size(u(12)).text_color(t.working)))
          .child(this.info(t, n, u, `wg-hl-${n.key}`)));
    });
    const frames = [...lay.boxes.keys()].map((key) => [model.nodes.get(key), this.place(`f:${key}`, rects.get(`f:${key}`))]);
    const cards = vis.cards.map((k) => this.card(t, model.nodes.get(k), this.place(`c:${k}`, rects.get(`c:${k}`)), u));
    const a = this.anim?.built ? this.anim : null;
    const ghosts = (a?.ghosts ?? []).map((g) => [g, model.nodes.get(g.key), a.phase > 0 ? { ...g.to, o: 0 } : { ...g.from, o: 1 }]);
    const note = this.edgeNote(t, model);
    const arrows = this.edges(t, model, vis, lay, u);
    const layer = (id, o, children) => div().id(id).absolute().top(0).left(0).size_full().opacity(o).transition("opacity", FADE).children(children);
    return div().relative().flex_none().w(u(lay.width)).h(u(lay.height))
      .children(bands)
      .children(frames.map(([n, r]) => this.frameBox(t, n, r, u)))
      .children(ghosts.filter(([g]) => g.kind === "frame").map(([, n, r]) => this.frameBox(t, n, r, u)))
      .child(div().absolute().top(0).left(0).size_full().children(arrows.hits))
      .children(laneHeads)
      .children(frames.map(([n, r]) => this.frameHead(t, n, r, u)))
      .children(ghosts.map(([g, n, r]) => (g.kind === "frame" ? this.frameHead(t, n, r, u) : this.card(t, n, r, u))))
      .children(cards)
      .child(div().id("wg-arrows").absolute().top(0).left(0).size_full().opacity(this.anim ? 0 : 1).transition("opacity", { duration: 180, easing: "ease-in-out" })
        .child(layer("wg-arrows-all", this.path ? DIM : 1, arrows.all))
        .child(layer("wg-arrows-path", this.path ? 1 : 0, arrows.lit)))
      .when(Boolean(note), (el) => el.child(note));
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
      const next = dir > 0 ? ZOOMS.find((x) => x > z + 0.001) : [...ZOOMS].reverse().find((x) => x < z - 0.001);
      this.setZoom(cx, next ?? z);
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
        .children(ready.slice(0, 8).map((n) => this.hover(`wg-hr-${n.key}`, n, div().id(`wg-ready-${n.key}`).flex_none().px(7).h(20).flex().items_center()
          .rounded(5).border_1().border_color(t.ansi2).text_color(t.foreground).hover((el) => el.bg(t.hover)).child(n.title))))
        .when(ready.length > 8, (el) => el.child(div().text_color(t.dim).child(`+${ready.length - 8} more`))));
  }

  render() {
    const t = theme();
    if (this.viewer) return this.fileView(t);
    const root = v_flex().id("work-graph").size_full().min_h(0).overflow_hidden().bg(t.canvas).text_color(t.foreground);
    if (!this.loaded) return root.child(div().p(PAD).text_color(t.dim).child("Reading the projects."));
    if (!this.projects.length) return root.child(div().p(PAD).text_color(t.dim).child(`No open projects in ${this.folder}.`));
    const sessions = liveSessions(terminals(), spaces(), this.records);
    const model = build({ projects: this.projects, graphs: this.graphs, issues: this.issues, prs: this.prs, asks: openAsks(this.files), sessions });
    this.model = model;
    this.sessions = sessions;
    const pointed = this.anim ? null : this.hoverCard ?? this.hoverPop;
    this.path = pointed ? pathOf(model, pointed) : null;
    if (this.path) this.fading = this.path;
    const vis = visible(model, (n) => this.isOpen(n));
    const lay = layout(model, vis);
    // Fit is worked out again only for a new level or a new pane size, so opening one node
    // doesn't rescale everything
    const fitKey = `${this.level}|${Math.round(this.viewW)}`;
    if (this.zoom === "fit" && this.viewW && this.fitKey !== fitKey) {
      this.fitKey = fitKey;
      this.fitZ = Math.max(MIN_FIT, Math.min(1, this.viewW / lay.width));
    }
    const z = this.zoom !== "fit" ? Number(this.zoom) || 1 : this.fitZ ?? 1;
    this.z = z;
    const u = (x) => Math.round(x * z * 10) / 10;
    const width = u(lay.width);
    const height = u(lay.height);
    const rects = new Map();
    for (const k of vis.cards) {
      const p = lay.pos.get(k);
      rects.set(`c:${k}`, { key: k, kind: "card", x: u(p.x), y: u(p.y), w: u(CARD_W), h: u(CARD_H) });
    }
    for (const [k, b] of lay.boxes) rects.set(`f:${k}`, { key: k, kind: "frame", x: u(b.x), y: u(b.y), w: u(b.w), h: u(b.h) });
    for (const l of lay.lanes) rects.set(`l:${l.key}`, { key: l.key, kind: "lane", x: 0, y: u(l.y), w: width, h: u(l.h) });
    if (this.anim && !this.anim.built) this.buildAnim(model, rects);
    if (!this.anim) this.last = rects;
    const maxX = Math.max(0, width - this.viewW);
    const maxY = Math.max(0, height - this.viewH);
    // Zooming around the pointer can leave the graph off the pane's edges, as long as some of it
    // still shows; otherwise it fills the pane from its top-left corner
    if (this.loose) {
      this.scrollX = Math.max(-(this.viewW - LOOSE), Math.min(width - LOOSE, this.scrollX));
      this.scrollY = Math.max(-(this.viewH - LOOSE), Math.min(height - LOOSE, this.scrollY));
    } else {
      this.scrollX = Math.max(0, Math.min(maxX, this.scrollX));
      this.scrollY = Math.max(0, Math.min(maxY, this.scrollY));
    }
    return root
      .on_mouse_move((e, cx) => {
        const d = this.drag;
        if (!d) return;
        const v = d.start + ((d.axis === "y" ? e.position.y : e.position.x) - d.from) * d.per;
        if (d.axis === "y") this.scrollY = Math.max(0, Math.min(maxY, v));
        else this.scrollX = Math.max(0, Math.min(maxX, v));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (!this.drag) return;
        this.drag = null;
        cx.notify();
      })
      .child(this.summary(t, model, z))
      // Scrolled by hand on both axes: a native scroller on both axes never moves down here, and
      // a change of what shows has to move the view with it to keep the opened node in place
      .child(div().id("wg-view").relative().flex_1().min_h(0).overflow_hidden()
        .on_size_change((size, cx) => {
          if (Math.abs(size.width - this.viewW) < 1 && Math.abs(size.height - this.viewH) < 1) return;
          this.viewW = size.width;
          this.viewH = size.height;
          cx.notify();
        })
        .on_scroll_wheel((e, cx) => {
          if (e.modifiers?.platform) {
            // Several wheel events can land before the next render, so each starts from the zoom
            // the last one left, not the one this render drew
            const z1 = this.z;
            // Scrolling up zooms in, as in a browser
            const z2 = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z1 * Math.exp(e.delta.y * ZOOM_RATE))) * 1000) / 1000;
            if (z2 === z1) return;
            // The point under the pointer stays under it
            const at = e.local_position ?? { x: e.position.x - (e.bounds?.x ?? 0), y: e.position.y - (e.bounds?.y ?? 0) };
            this.scrollX = ((this.scrollX + at.x) / z1) * z2 - at.x;
            this.scrollY = ((this.scrollY + at.y) / z1) * z2 - at.y;
            this.loose = true;
            this.z = z2;
            this.setZoom(cx, z2);
            return;
          }
          // Panning moves within the graph, or back toward it from where a zoom left it, never away
          const pan = (v, d, max) => Math.max(Math.min(0, v), Math.min(Math.max(max, v), v - d));
          this.scrollX = pan(this.scrollX, e.delta.x, maxX);
          this.scrollY = pan(this.scrollY, e.delta.y, maxY);
          if (this.scrollX >= 0 && this.scrollX <= maxX && this.scrollY >= 0 && this.scrollY <= maxY) this.loose = false;
          cx.notify();
        })
        .child(this.canvas(t, model, vis, lay, u, rects).id("wg-canvas").absolute().left(-this.scrollX).top(-this.scrollY)
          .when(Boolean(this.anim), (el) => el.transition("left", EASE).transition("top", EASE)))
        .when(maxY > 0, (el) => el.child(this.bar(t, "y", height, maxY))))
      .when(maxX > 0, (el) => el.child(this.bar(t, "x", width, maxX)));
  }
}
