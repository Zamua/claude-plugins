// A sidebar of the session tree: the root, each project's coordinator as a folder, its workers
// under it. props: { folder } (the projects folder), { part: "header" } for the bar above it
// and { mode: "new" } for the new-session dialog.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, theme, props, openOverlay, closeOverlay, watchFolder, window, spaces, exec, setAgentOrder, focused, home, nextCommand, panes, terminals } from "herdr";
import { folderOf, readFiles, model } from "./state.js";

const ICON = (name) => `mods/session-tree/${name}.svg`;
// Every tree row is this tall, so each row's guide lines meet the next row's
const ROW = 24;
const GUIDE = 12;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

const expand = (path) => (path.startsWith("~") ? home() + path.slice(1) : path);
const focus = (s) => s && run("pane.focus", { terminal: s.address });

// One indent step of the tree's lines: "│" passes by, "├" branches off, "└" ends, "" is blank.
function guide(t, kind) {
  const color = t.input;
  return v_flex()
    .w(GUIDE)
    .h(ROW)
    .flex_none()
    .child(div().w(GUIDE - 3).h(ROW / 2)
      .when(kind !== "", (el) => el.border_l(1).border_color(color))
      .when(kind === "├" || kind === "└", (el) => el.border_b(1).border_color(color).when(kind === "└", (el) => el.rounded_bl(4))))
    .child(div().h(ROW / 2).when(kind === "│" || kind === "├", (el) => el.border_l(1).border_color(color)));
}

const WORD = { working: "working", done: "finished", idle: "idle", blocked: "waiting on a dialog" };

export default class SessionTree extends View {
  init(_props, cx) {
    this.folder = folderOf(props());
    this.files = new Map();
    const mode = props()?.mode;
    if (mode === "new") this.initNew(cx);
    if (!mode && props()?.part !== "header") {
      this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
      this.lastRoot = JSON.parse(localStorage.getItem("root") ?? "null");
      cx.spawn(async (cx) => {
        for (;;) {
          const command = await nextCommand();
          if (command === "close" || command === "close-pane") this.guardClose(command === "close-pane");
          if (command === "new") this.openNew();
          cx.notify();
        }
      });
      cx.timer.every(5000, () => this.syncOrder());
    }
    cx.spawn(async (cx) => {
      this.files = await readFiles(this.folder);
      cx.notify();
      if (mode) return;
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
  }

  // Cmd+W and Cmd+Shift+W, bound to this mod in keys.json: closing what holds a live agent asks first.
  guardClose(isPane) {
    const f = focused();
    const target = isPane ? f?.pane : f?.tab;
    if (!target) return;
    const live = new Map(terminals().filter((t) => t.state === "live").map((t) => [t.address, t]));
    const agents = panes()
      .filter((p) => p.terminal && (isPane ? p.pane === target : p.tab === target))
      .map((p) => live.get(p.terminal))
      .filter((t) => t && (t.labels?.["tree.role"] || t.program?.agent));
    if (!agents.length) return run(isPane ? "pane.close" : "tab.close", isPane ? { pane: target } : { id: target });
    const isRoot = agents.some((t) => t.labels?.["tree.role"] === "root");
    const names = agents.map((t) => t.name || t.labels?.["tree.project"] || t.program?.name || t.address).join(", ");
    openOverlay({
      mod: "confirm", kind: "dialog", width: 440, height: 190,
      props: {
        title: isRoot ? "Close the root session?" : `Close ${names}?`,
        detail: isRoot
          ? "This ends root, the session you talk to. The tree shows a Reopen row for it afterwards."
          : `This ends the Claude session${agents.length > 1 ? "s" : ""} running here.`,
        command: isPane ? { name: "pane.close", args: { pane: target } } : { name: "tab.close", args: { id: target, confirmed: true } },
      },
    });
  }

  // Herdr's space order follows the tree's, so stepping through spaces walks the sidebar top to
  // bottom: the root's space, then each project's by its `order`, then the rest as they were.
  syncOrder() {
    const m = model(this.files);
    const now = spaces().filter((sp) => !sp.machine).map((sp) => sp.id);
    const tree = [m.root?.space, ...m.projects.map((p) => p.lead?.space ?? p.workers[0]?.space)].filter((id) => id && now.includes(id));
    const want = [...new Set(tree), ...now.filter((id) => !tree.includes(id))];
    const at = want.findIndex((id, i) => now[i] !== id);
    if (at >= 0) run("space.move", { id: want[at], index: at + 1 });
  }

  openNew() {
    const m = model(this.files);
    const project = m.sessions.find((s) => s.address === focused()?.terminal)?.project;
    openOverlay({ mod: "session-tree", kind: "dialog", width: 520, props: { mode: "new", folder: props()?.folder, project: project === m.root?.project ? "" : project } });
  }

  reopenRoot(cx) {
    const r = this.lastRoot;
    if (!r?.sid || this.reopening) return;
    this.reopening = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const done = await exec(`${this.folder}/bin/tree-start`, [r.name, r.project, "root", r.cwd || home(), "--resume", r.sid]);
        if (done.code !== 0) this.reopenError = (done.stderr || done.stdout).trim().split("\n")[0];
      } catch (e) {
        this.reopenError = String(e?.message ?? e);
      }
      this.reopening = false;
      cx.notify();
    });
  }

  // One glyph per status, its word in the tooltip: a red ! waits on a dialog, a red hand has open
  // asks, a spinner works, a dot is done or idle.
  glyph(t, id, s) {
    if (!s) return div().w(14).flex_none();
    const box = h_flex().id(`st-g-${id}`).w(14).h(ROW).flex_none().items_center().justify_center();
    if (s.status === "blocked") return box.tooltip(WORD.blocked).child(div().text_size(13).font_bold().text_color(t.blocked).child("!"));
    if (s.needs) return box.tooltip(`${s.asks?.length ?? ""} open ask${s.asks?.length === 1 ? "" : "s"}`.trim()).child(svg(ICON("hand")).size(12).text_color(t.blocked));
    if (s.status === "working") return box.tooltip(WORD.working).child(svg(ICON("spinner")).size(10).text_color(t.working).spin(900));
    return box.tooltip(WORD[s.status] ?? s.status).child(div().size(5).rounded_full().bg(s.status === "done" ? t.done : t.dim));
  }

  fold(t, p, open) {
    return div().id(`st-f-${p.name}`).w(14).h(ROW).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t.dim).hover((el) => el.text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        open ? this.folded.add(p.name) : this.folded.delete(p.name);
        localStorage.setItem("folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(10));
  }

  header(t) {
    const w = window();
    return h_flex().size_full().bg(t.chrome).pl(w?.platform === "macos" && !w?.fullscreen ? 80 : 14).pr(10).gap(8).items_center()
      .child(image("frame/welcome/herdr.png").size(18).rounded(5))
      .child(div().truncate().text_size(13.5).font_semibold().text_color(t.foreground).child("Herdr"));
  }

  list(t, m) {
    const shown = focused()?.terminal;
    const order = [];
    const rows = [];
    const row = (id, s) => {
      if (s) order.push(s.address);
      return h_flex().id(id).h(ROW).flex_none().mx(4).pl(8).pr(4).items_center().rounded(6)
        .when(Boolean(s) && s.address === shown, (el) => el.bg(t.selected))
        .hover((el) => el.bg(t.hover))
        .when(Boolean(s), (el) => el.cursor_pointer().on_click(() => focus(s)));
    };
    const name = (text, color, weight) => div().flex_1().min_w(0).truncate().text_size(12.5).text_color(color)
      .when(weight, (el) => el.font_medium()).child(text);

    if (m.root?.sid && (m.root.sid !== this.lastRoot?.sid || m.root.cwd !== this.lastRoot?.cwd)) {
      this.lastRoot = { sid: m.root.sid, cwd: m.root.cwd, name: m.root.name, project: m.root.project };
      localStorage.setItem("root", JSON.stringify(this.lastRoot));
    }
    if (!m.root && this.lastRoot) {
      rows.push(row("st-root-gone", null).cursor_pointer().on_click((_e, cx) => this.reopenRoot(cx))
        .child(svg(ICON("layers")).size(12).flex_none().mr(6).text_color(t.blocked))
        .child(name(this.reopenError ?? `${this.lastRoot.name} closed`, t.muted, false))
        .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.blocked).child(this.reopening ? "…" : "Reopen")));
    }
    if (m.root) {
      rows.push(row("st-root", m.root)
        .child(svg(ICON("layers")).size(12).flex_none().mr(6).text_color(t.foreground))
        .child(name(m.root.name, t.foreground, true))
        .child(div().w(14).flex_none())
        .child(this.glyph(t, "root", m.root)));
    }

    const projects = m.projects.map((p) => ({ p, workers: p.workers }));
    projects.forEach(({ p, workers }, i) => {
      const last = i === projects.length - 1;
      const open = !this.folded.has(p.name);
      const hidden = open ? [] : p.workers;
      const blocked = p.lead?.status === "blocked" || hidden.some((w) => w.status === "blocked");
      const needs = Boolean(p.lead?.needs) || hidden.some((w) => w.needs);
      rows.push(row(`st-p-${p.name}`, p.lead)
        .child(guide(t, last ? "└" : "├"))
        .child(name(p.title, t.foreground, true))
        .child(p.workers.length > 0 ? this.fold(t, p, open) : div().w(14).flex_none())
        .child(this.glyph(t, `p-${p.name}`, { status: blocked ? "blocked" : p.status, needs, asks: p.lead?.asks })));
      if (!open) return;
      workers.forEach((w, j) => rows.push(row(`st-w-${w.address}`, w)
        .child(guide(t, last ? "" : "│"))
        .child(guide(t, j === workers.length - 1 ? "└" : "├"))
        .child(name(w.name, w.status === "idle" && !w.needs ? t.dim : t.muted, false))
        .child(div().w(14).flex_none())
        .child(this.glyph(t, `w-${w.address}`, w))));
    });

    // Spaces outside the tree stay reachable from here, since this sidebar replaces the spaces list
    const tree = new Set(m.sessions.map((s) => s.space));
    const others = spaces().filter((sp) => !tree.has(sp.id));
    if (others.length) {
      rows.push(div().pl(12).pt(10).pb(2).text_size(11).text_color(t.dim).child("Other spaces"));
      for (const sp of others) {
        rows.push(row(`st-s-${sp.id}`, null).when(sp.active, (el) => el.bg(t.selected)).cursor_pointer()
          .on_click(() => run("space.select", { id: sp.id }))
          .child(name(sp.name, t.muted, false))
          .child(div().w(14).flex_none())
          .child(this.glyph(t, `s-${sp.id}`, sp.status ? { status: sp.status } : null)));
      }
    }
    setAgentOrder(order);

    const empty = "No sessions in the tree yet.";
    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .child(div().mx(10).mb(4).h(1).flex_none().bg(t.border))
      .child(v_flex().id("st-list").flex_1().min_h(0).pb(6).overflow_y_scrollbar()
        .children(rows.length ? rows : [div().px(12).py(6).text_size(12).text_color(t.dim).child(empty)]));
  }

  initNew(cx) {
    this.form = { name: "", project: props()?.project ?? "", cwd: "~", brief: "" };
    this.fields = {};
    const hints = { name: "fix-login", project: "the project it belongs to", cwd: "~/workspace/repo", brief: "What it should do first" };
    for (const k of Object.keys(this.form)) {
      const input = InputState.new({ placeholder: hints[k], value: this.form[k] });
      input.on("change", (_e, cx) => {
        this.form[k] = input.value();
        this.error = null;
        cx.notify();
      });
      input.on("submit", (_e, cx) => this.start(cx));
      this.fields[k] = input;
    }
    this.fields.name.focus();
    cx.timer.after(600, () => this.fields.name.focus());
    this.handle = cx.focus_handle();
  }

  plan() {
    const name = this.form.name.trim();
    const project = this.form.project.trim() || name;
    const lead = model(this.files).projects.find((p) => p.name === project)?.lead ?? null;
    return { name, project, lead };
  }

  start(cx) {
    if (this.busy) return;
    const { name, project, lead } = this.plan();
    if (!NAME.test(name) || !NAME.test(project)) {
      this.error = "Names take lowercase letters, digits and dashes.";
      return cx.notify();
    }
    const brief = this.form.brief.trim();
    const args = [name, project, lead ? "worker" : "project", expand(this.form.cwd.trim() || "~"),
      ...(lead ? ["--parent", lead.name] : []), ...(brief ? ["--prompt", brief] : [])];
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(`${this.folder}/bin/tree-start`, args);
        if (r.code === 0) return closeOverlay(props().overlay);
        this.error = (r.stderr || r.stdout).trim().split("\n")[0] || `tree-start exited ${r.code}`;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  newDialog(t) {
    const { name, project, lead } = this.plan();
    const hint = !name ? "" : lead ? `Starts a worker under ${lead.name}.` : `Starts ${name} as the coordinator of a new project, ${project}.`;
    const field = (k, label) => v_flex().gap(6)
      .child(div().text_size(11.5).text_color(t.dim).child(label))
      .child(Input.new(this.fields[k]).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground));
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("st-new-dialog").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          closeOverlay(props().overlay);
          cx.stop_propagation();
        }
      })
      .w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("New session"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().gap(10).child(div().flex_1().child(field("name", "Name"))).child(div().flex_1().child(field("project", "Project"))))
      .child(field("cwd", "Folder"))
      .child(field("brief", "Brief"))
      .child(div().text_size(11.5).text_color(this.error ? t.blocked : t.dim).child(this.error ?? hint))
      .child(h_flex().gap(8).justify_end()
        .child(button("st-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("st-start", this.busy ? "Starting…" : "Start", true, (_e, cx) => this.start(cx))));
  }

  render() {
    const t = theme();
    const mode = props()?.mode;
    if (mode === "new") return this.newDialog(t);
    if (props()?.part === "header") return this.header(t);
    const m = model(this.files);
    return this.list(t, m);
  }
}
