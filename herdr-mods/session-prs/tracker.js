// Tracker tabs: each JSON file listed in ~/.config/herdr-app/session-prs.json as
// { "trackers": ["<path>", ...] } becomes a tab named by the file's `title`. A tracker file is
// { title, updated_at, envs: [..], sections: [{ id, title, items: [{ id, title, status, owner,
// note, env: { <env>: value }, after: [item ids], detail (Markdown), links: [{ label, url }] }] }] }.
// The tab reads the file and never writes it.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, home, readTextFile, openOverlay } from "herdr";

const CONFIG = "/.config/herdr-app/session-prs.json";
const ROW = 22;
// Most urgent first, the order a section's counts are listed in
const ORDER = ["gap", "blocked", "doing", "ready", "todo", "watching", "done"];
const TAGS = { blocked: "block", watching: "watch" };
const tagOf = (status) => TAGS[status] ?? status;

const expand = (p) => (p.startsWith("~") ? home() + p.slice(1) : p);

export async function readTrackers() {
  let paths = [];
  try {
    paths = JSON.parse((await readTextFile(home() + CONFIG)) ?? "{}").trackers ?? [];
  } catch {
    return [];
  }
  return Promise.all(paths.filter((p) => typeof p === "string").map(async (path) => {
    const full = expand(path);
    const tracker = { path: full, dir: full.slice(0, full.lastIndexOf("/")), name: full.split("/").pop().replace(/\.json$/, "") };
    try {
      const text = await readTextFile(full);
      if (text == null) return { ...tracker, error: `No file at ${path}` };
      return { ...tracker, data: JSON.parse(text) };
    } catch (e) {
      return { ...tracker, error: `Could not read ${path}: ${e?.message ?? e}` };
    }
  }));
}

export const trackerTitle = (tr) => tr.data?.title || tr.name;
export const gapCount = (tr) => (tr.data?.sections ?? []).reduce((n, s) => n + (s.items ?? []).filter((i) => i.status === "gap").length, 0);

function statusColor(t, status) {
  return { gap: t.ansi3, blocked: t.blocked, doing: t.ansi2, ready: t.ansi4, watching: t.ansi5 }[status] ?? t.dim;
}

function envColor(t, value) {
  const v = String(value).toLowerCase();
  if (["on", "set", "done", "allowed"].includes(v)) return t.ansi2;
  if (["gap", "missing", "unknown"].includes(v) || v.endsWith("%")) return t.ansi3;
  if (["blocked", "suspended"].includes(v)) return t.blocked;
  if (["off", "n/a", "todo", "pending"].includes(v)) return t.dim;
  return t.muted;
}

const ENV_W = 48;

function envCells(t, envs, item, key) {
  return envs.map((env) => {
    const v = item?.env?.[env] ?? "";
    return div().id(`tr-env-${key}-${env}`).w(ENV_W).flex_none().truncate().text_color(envColor(t, v))
      .when(v.length > 6, (el) => el.tooltip(`${env}: ${v}`)).child(v);
  });
}

const waitsOn = (item, byId) => (item.after ?? []).map((id) => byId.get(id)).filter((x) => x && x.status !== "done");

// The title keeps its width until the row runs out; the note, or what the item waits on, fills
// whatever is left
function row(t, item, ctx, { tag = true, envs = [] } = {}) {
  const waiting = waitsOn(item, ctx.byId);
  const quiet = item.status === "done";
  const tail = waiting.length ? `after ${waiting[0].title}` : item.note ?? "";
  return h_flex().id(`tr-${tag ? "i" : "g"}-${item.id}`).h(ROW).flex_none().px(12).gap(8).items_center().whitespace_nowrap()
    .rounded(5).cursor_pointer().hover((el) => el.bg(t.hover))
    .on_click(() => ctx.open(item))
    .when(tag, (el) => el.child(div().w(42).flex_none().text_color(statusColor(t, item.status)).when(item.status === "gap", (el) => el.font_bold()).child(tagOf(item.status))))
    .child(h_flex().flex_1().min_w(0).gap(8)
      .child(div().min_w(0).truncate().text_color(quiet ? t.dim : t.foreground).child(item.title))
      .child(div().flex_1().min_w(0).truncate().text_color(waiting.length ? t.ansi5 : t.dim).child(tail)))
    .child(div().w(72).flex_none().truncate().text_color(t.dim).child(item.owner ?? ""))
    .children(envCells(t, envs, item, `${tag ? "i" : "g"}-${item.id}`));
}

function counts(t, items) {
  return ORDER.flatMap((s) => {
    const n = items.filter((i) => i.status === s).length;
    return n ? [div().flex_none().text_color(s === "gap" || s === "blocked" ? statusColor(t, s) : t.dim).child(`${n} ${tagOf(s)}`)] : [];
  });
}

function envHeader(t, envs) {
  return h_flex().h(18).px(12).gap(8).items_center().justify_end().text_size(11).text_color(t.dim)
    .children(envs.map((env) => div().w(ENV_W).flex_none().truncate().child(env)));
}

// The tab's body: every item's count by status, the gaps from every section, then each section.
// A folded section still shows its blocked items, since those are what someone has to unstick.
export function trackerBody(t, tr, open, toggle, updated) {
  if (!tr.data) return div().px(12).py(8).text_color(tr.error ? t.blocked : t.dim).child(tr.error ?? "Reading the tracker.");
  const envs = tr.data.envs ?? [];
  const sections = tr.data.sections ?? [];
  const all = sections.flatMap((s) => s.items ?? []);
  const byId = new Map(all.map((i) => [i.id, i]));
  const ctx = {
    byId,
    open: (item) => openOverlay({ mod: "session-prs", kind: "dialog", width: 640, props: {
      mode: "tracker-item", item, envs,
      section: sections.find((s) => (s.items ?? []).includes(item))?.title ?? "",
      waiting: waitsOn(item, byId).map((x) => ({ title: x.title, status: x.status })),
    } }),
  };
  const head = (id, title, extra) => h_flex().id(`tr-h-${id}`).h(ROW).px(12).mt(10).gap(8).items_center().whitespace_nowrap()
    .border_b(1).border_color(t.border).cursor_pointer().on_click((_e, cx) => toggle(id, cx))
    .child(div().w(10).flex_none().text_color(t.dim).child(open.has(id) ? "▾" : "▸"))
    .child(div().min_w(0).truncate().font_bold().text_color(t.foreground).child(title))
    .child(div().flex_1())
    .child(h_flex().flex_none().gap(8).children(extra));
  const rows = [
    h_flex().px(12).pt(6).gap(10).items_start()
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap_x(10).text_color(t.dim)
        .child(div().flex_none().text_color(t.foreground).child(`${all.length} items`))
        .children(counts(t, all)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(updated)),
  ];
  const gapSections = sections.map((s) => ({ s, gaps: (s.items ?? []).filter((i) => i.status === "gap") })).filter((g) => g.gaps.length);
  const gapTotal = gapSections.reduce((n, g) => n + g.gaps.length, 0);
  if (gapTotal) {
    rows.push(head("gaps", "Decisions and gaps", [div().text_color(t.ansi3).font_bold().child(String(gapTotal))]));
    if (open.has("gaps")) {
      for (const { s, gaps } of gapSections) {
        rows.push(h_flex().h(20).px(12).pt(4).gap(6).items_end().text_size(11).text_color(t.dim)
          .child(div().child(s.title)).child(div().child(`· ${gaps.length}`)));
        rows.push(...gaps.map((i) => row(t, i, ctx, { tag: false })));
      }
    }
  }
  for (const s of sections) {
    const items = s.items ?? [];
    rows.push(head(s.id, s.title, counts(t, items)));
    const shown = open.has(s.id) ? items : items.filter((i) => i.status === "blocked");
    const cols = envs.length && shown.some((i) => i.env) ? envs : [];
    if (cols.length) rows.push(envHeader(t, cols));
    rows.push(...shown.map((i) => row(t, i, ctx, { envs: cols })));
  }
  return v_flex().id(`tracker-${tr.name}`).flex_1().min_h(0).pb(8).overflow_y_scrollbar().children(rows);
}

export function trackerDialog(t, p, close, handle) {
  const { item, envs = [], section, waiting = [] } = p;
  const links = item.links ?? [];
  const env = envs.filter((e) => item.env?.[e]).map((e) => h_flex().gap(4).child(div().text_color(t.dim).child(e)).child(div().text_color(envColor(t, item.env[e])).child(item.env[e])));
  return v_flex().id("tracker-dialog").track_focus(handle)
    .on_key_down((e, cx) => {
      if (e.key === "escape") {
        close();
        cx.stop_propagation();
      }
    })
    .w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
    .child(h_flex().items_start().gap(10)
      .child(div().flex_none().text_size(13).font_semibold().text_color(statusColor(t, item.status)).child(tagOf(item.status)))
      .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(item.title))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
    .child(div().text_size(11.5).text_color(t.dim).child([section, item.owner].filter(Boolean).join(" · ")))
    .when(env.length > 0, (el) => el.child(h_flex().gap(14).text_size(12).children(env)))
    .when(waiting.length > 0, (el) => el.child(div().text_size(12.5).text_color(t.ansi5).child(`After ${waiting.map((w) => `${w.title} (${w.status})`).join(", ")}`)))
    .when(Boolean(item.note), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(item.note)))
    .when(Boolean(item.detail), (el) => el.child(div().id("tracker-detail").max_h(380).overflow_y_scrollbar()
      .child(TextView.markdown("tracker-detail-md", item.detail).selectable(true).text_size(12.5).text_color(t.muted))))
    .when(links.length > 0, (el) => el.child(v_flex().gap(2).children(links.map((l, k) => div().id(`tracker-link-${k}`).truncate().text_size(12)
      .text_color(t.accent).cursor_pointer().hover((el) => el.underline()).on_click(() => exec("open", [l.url])).child(l.label || l.url)))))
    .child(h_flex().pt(4).child(div().flex_1())
      .child(h_flex().id("tracker-close").h(30).px(12).items_center().rounded(7).cursor_pointer().border_1().border_color(t.input).bg(t.raised)
        .hover((el) => el.opacity(0.88)).on_click(() => close()).child("Close")));
}
