// A sidebar of the session tree: the root, each project's coordinator as a folder, its workers
// under it. props: { folder } (the projects folder), { part: "header" } for the bar above it,
// { mode: "asks" } for the bell's popup and { mode: "new" } for the new-session dialog.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, theme, props, openOverlay, closeOverlay, watchFolder, window, spaces, exec, setAgentOrder, layout, focused, shared, setShared, home } from "herdr";
import { folderOf, readFiles, model, needs } from "./state.js";

const ICON = (name) => `mods/session-tree/${name}.svg`;
// Set by the header's hand, read by the list: two copies of this mod
const ONLY = "session-tree.only";
// Every tree row is this tall, so each row's guide lines meet the next row's
const ROW = 30;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const expand = (path) => (path.startsWith("~") ? home() + path.slice(1) : path);
const focus = (s) => s && run("pane.focus", { terminal: s.address });

function openPrs() {
  if (find(layout(), "prs")) run("layout.toggle", { id: "prs" });
  else openOverlay({ mod: "session-prs", kind: "window", key: "session-prs", width: 760, height: 640, props: { folder: props()?.folder } });
}

// One indent step of the tree's lines: "│" passes by, "├" branches off, "└" ends, "" is blank.
function guide(t, kind, width) {
  const color = t.input;
  return v_flex()
    .w(width)
    .h(ROW)
    .flex_none()
    .child(div().w(Math.min(14, width - 4)).h(ROW / 2)
      .when(kind !== "", (el) => el.border_l(1).border_color(color))
      .when(kind === "├" || kind === "└", (el) => el.border_b(1).border_color(color).when(kind === "└", (el) => el.rounded_bl(6))))
    .child(div().h(ROW / 2).when(kind === "│" || kind === "├", (el) => el.border_l(1).border_color(color)));
}

export default class SessionTree extends View {
  init(_props, cx) {
    this.folder = folderOf(props());
    this.files = new Map();
    const mode = props()?.mode;
    if (mode === "new") this.initNew(cx);
    if (!mode && props()?.part !== "header") {
      this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
      this.search = "";
      this.input = InputState.new({ placeholder: "Search" });
      this.input.on("change", (_e, cx) => {
        this.search = this.input.value();
        cx.notify();
      });
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

  // "needs you" with a hand, else the status word.
  state(t, s) {
    if (s.needs) {
      return h_flex().flex_none().gap(4).items_center().text_size(11.5).font_semibold().text_color(t.blocked)
        .child(svg(ICON("hand")).size(12)).child("needs you");
    }
    const color = s.status === "done" ? t.done : s.status === "working" ? t.muted : t.dim;
    return div().flex_none().text_size(11.5).text_color(color).child(s.status);
  }

  dot(t, s) {
    if (s.needs) return svg(ICON("hand")).size(13).flex_none().text_color(t.blocked);
    const color = t[s.status] ?? t.dim;
    return h_flex().w(13).flex_none().justify_center()
      .child(div().size(7).rounded_full().bg(color).when(s.status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1400 })));
  }

  round(t, id, icon, tip, on, action, badge = 0) {
    return div().id(id).relative().size(28).flex_none().flex().items_center().justify_center().rounded_full()
      .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(svg(ICON(icon)).size(15))
      .when(badge > 0, (el) => el.child(div().absolute().top(-4).right(-6).h(15).min_w(15).px(4).rounded_full().bg(t.blocked)
        .text_size(9.5).font_bold().text_color(t.background).flex().items_center().justify_center().child(String(badge))));
  }

  header(t, m) {
    const w = window();
    const only = Boolean(shared(ONLY));
    const prs = find(layout(), "prs");
    const count = needs(m).length;
    return h_flex().size_full().bg(t.chrome).pl(w?.platform === "macos" && !w?.fullscreen ? 80 : 14).pr(10).gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(image("frame/welcome/herdr.png").size(18).rounded(5))
        .child(div().truncate().text_size(13.5).font_semibold().text_color(t.foreground).child("Herdr")))
      .child(this.round(t, "st-prs", "gauge", "Pull requests", Boolean(prs && !prs.hidden), openPrs))
      .child(this.round(t, "st-bell", "bell", count ? `${count} need you` : "Nothing needs you", false,
        () => openOverlay({ mod: "session-tree", kind: "popup", width: 380, height: 440, props: { mode: "asks", folder: props()?.folder } }), count))
      .child(this.round(t, "st-only", "hand", only ? "Show every session" : "Show only what needs you", only, () => setShared(ONLY, !only)));
  }

  list(t, m) {
    const only = Boolean(shared(ONLY));
    const q = this.search.trim().toLowerCase();
    const hit = (s) => Boolean(s) && (!only || s.needs) && (!q || s.name.toLowerCase().includes(q));
    const shown = focused()?.terminal;
    const order = [];
    const rows = [];
    const row = (id, s) => {
      if (s) order.push(s.address);
      return h_flex().id(id).h(ROW).flex_none().mx(8).pl(18).pr(10).items_center().rounded(8)
        .when(Boolean(s) && s.address === shown, (el) => el.bg(t.selected))
        .hover((el) => el.bg(t.hover))
        .when(Boolean(s), (el) => el.cursor_pointer().on_click(() => focus(s)));
    };

    if (hit(m.root)) {
      order.push(m.root.address);
      rows.push(h_flex().id("st-root").h(36).flex_none().mx(8).mb(2).px(10).gap(10).items_center().rounded(10)
        .bg(m.root.address === shown ? t.selected : t.raised).hover((el) => el.bg(t.hover)).cursor_pointer()
        .on_click(() => focus(m.root))
        .child(svg(ICON("layers")).size(16).flex_none().text_color(t.foreground))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_medium().text_color(t.foreground).child(m.root.name))
        .child(this.state(t, m.root)));
    }

    const projects = m.projects
      .map((p) => {
        const titled = q && p.title.toLowerCase().includes(q) && !only;
        const workers = titled ? p.workers : p.workers.filter(hit);
        return { p, workers, show: titled || hit(p.lead) || workers.length > 0 };
      })
      .filter((x) => x.show);
    projects.forEach(({ p, workers }, i) => {
      const last = i === projects.length - 1;
      const open = Boolean(q || only) || !this.folded.has(p.name);
      const needy = Boolean(p.lead?.needs) || (!open && p.workers.some((w) => w.needs));
      rows.push(row(`st-p-${p.name}`, p.lead)
        .child(guide(t, last ? "└" : "├", 24))
        .child(svg(ICON("folder")).size(16).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).ml(10).truncate().text_size(13).text_color(t.foreground).child(p.title))
        .child(this.state(t, { status: p.status, needs: needy }))
        .when(p.workers.length > 0 && !q && !only, (el) => el.child(div().id(`st-f-${p.name}`).ml(6).p(2).rounded(4).flex_none()
          .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            open ? this.folded.add(p.name) : this.folded.delete(p.name);
            localStorage.setItem("folded", JSON.stringify([...this.folded]));
            cx.notify();
          })
          .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12)))));
      if (!open) return;
      workers.forEach((w, j) => rows.push(row(`st-w-${w.address}`, w)
        .child(guide(t, last ? "" : "│", 32))
        .child(guide(t, j === workers.length - 1 ? "└" : "├", 20))
        .child(this.dot(t, w))
        .child(div().flex_1().min_w(0).ml(10).truncate().text_size(12.8).text_color(w.status === "idle" && !w.needs ? t.muted : t.foreground).child(w.name))
        .when(w.needs, (el) => el.child(this.state(t, w)))));
    });

    // Spaces outside the tree stay reachable from here, since this sidebar replaces the spaces list
    const tree = new Set([m.root?.project, ...m.projects.map((p) => p.name)]);
    const others = only ? [] : spaces().filter((sp) => !tree.has(sp.id) && (!q || sp.name.toLowerCase().includes(q)));
    if (others.length) {
      rows.push(div().px(18).pt(14).pb(4).text_size(11).font_medium().text_color(t.dim).child("Other spaces"));
      for (const sp of others) {
        rows.push(h_flex().id(`st-s-${sp.id}`).h(28).flex_none().mx(8).px(10).gap(10).items_center().rounded(8)
          .when(sp.active, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover)).cursor_pointer()
          .on_click(() => run("space.select", { id: sp.id }))
          .child(svg(ICON("folder")).size(14).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(t.muted).child(sp.name))
          .when(Boolean(sp.status) && sp.status !== "idle", (el) => el.child(this.state(t, { status: sp.status, needs: sp.status === "blocked" }))));
      }
    }
    setAgentOrder(order);

    const empty = only ? "Nothing needs you." : q ? "No session matches." : "No sessions in the tree yet.";
    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .child(div().mx(16).mb(8).h(1).flex_none().bg(t.border))
      .child(v_flex().id("st-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar()
        .children(rows.length ? rows : [div().px(18).py(6).text_size(12).text_color(t.dim).child(empty)]))
      .child(h_flex().flex_none().h(52).px(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(this.round(t, "st-settings", "settings", "Settings", false, () => run("app.settings")))
        .child(h_flex().id("st-search").flex_1().min_w(0).h(30).px(10).gap(6).items_center().rounded_full().bg(t.raised)
          .border_1().border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(svg(ICON("search")).size(13).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
        .child(this.round(t, "st-new", "square-pen", "New session", false, () => {
          const project = m.sessions.find((s) => s.address === focused()?.terminal)?.project;
          openOverlay({ mod: "session-tree", kind: "dialog", width: 520, props: { mode: "new", folder: props()?.folder, project: project === m.root?.project ? "" : project } });
        })));
  }

  asks(t, m) {
    const list = needs(m);
    const text = (a) => a.ask ?? a.question ?? a.title ?? a.id;
    return v_flex().size_full().min_h(0).bg(t.popover).p(6).text_size(12.5)
      .child(h_flex().px(8).pt(6).pb(8).items_center()
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child("Needs you"))
        .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
      .when(list.length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("Nothing needs you.")))
      .child(v_flex().id("st-asks").flex_1().min_h(0).overflow_y_scrollbar().children(list.map((n, i) =>
        v_flex().id(`st-ask-${i}`).flex_none().px(8).py(6).gap(2).rounded(7).hover((el) => el.bg(t.hover)).cursor_pointer()
          .on_click(() => {
            closeOverlay(props().overlay);
            focus(n.s);
          })
          .child(h_flex().gap(7).items_center()
            .child(svg(ICON("hand")).size(12).flex_none().text_color(t.blocked))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(n.ask ? text(n.ask) : "Waiting on a dialog")))
          .child(div().pl(19).truncate().text_size(11).text_color(t.dim).child([n.s.name, n.ask?.due].filter(Boolean).join(" · "))))));
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
    const m = model(this.files);
    if (mode === "asks") return this.asks(t, m);
    if (props()?.part === "header") return this.header(t, m);
    return this.list(t, m);
  }
}
