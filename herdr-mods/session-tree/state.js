// The session tree: terminals labelled tree.role, tree.project and tree.parent, joined to
// the state file each session keeps at <folder>/<project>/<session>.json.

import { readTextFile, home, terminals, spaces } from "herdr";
import { readdir } from "fs/promises";

export const RANK = { blocked: 4, working: 3, done: 2, idle: 1 };

export const folderOf = (p) => {
  const f = p?.folder ?? "~/projects";
  return f.startsWith("~") ? home() + f.slice(1) : f;
};

export async function readFiles(folder) {
  const files = new Map();
  let dirs = [];
  try {
    dirs = await readdir(folder, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || /^[._]/.test(d.name) || d.name === "bin") continue;
    let names = [];
    try {
      names = await readdir(`${folder}/${d.name}`);
    } catch {
      continue;
    }
    // A project's graph.json is the work-graph mod's, not a session's state
    for (const n of names.filter((n) => n.endsWith(".json") && n !== "graph.json")) {
      try {
        const text = await readTextFile(`${folder}/${d.name}/${n}`);
        if (text) files.set(`${d.name}/${n.slice(0, -5)}`, JSON.parse(text));
      } catch {
        // A file caught mid-write is read again on its next change
      }
    }
  }
  return files;
}

// tree-start takes any role; everything but the root and a worker leads its project
const isLead = (role) => role !== "root" && role !== "worker";
const statusOf = (t) => (t.status === "error" ? "blocked" : RANK[t.status] ? t.status : "idle");
const top = (list) => list.reduce((m, s) => (RANK[s.status] > RANK[m] ? s.status : m), "idle");

export function model(files) {
  const tabs = new Map(spaces().flatMap((sp) => sp.tabs.filter((tab) => tab.named).map((tab) => [tab.id, tab.name])));
  const sessions = terminals()
    .filter((t) => t.state === "live" && t.labels?.["tree.role"])
    .map((t) => {
      const project = t.labels["tree.project"] ?? "";
      const role = t.labels["tree.role"];
      // A terminal started by hand has no name, so its session goes by its tab, else its project
      const name = t.name || tabs.get(t.labels["herdr.tab"]) || (role === "worker" ? t.address : project);
      // A coordinator's state file may be named for its project rather than its terminal
      const file = files.get(`${project}/${name}`) ?? (isLead(role) ? files.get(`${project}/${project}`) : null) ?? {};
      return { name, address: t.address, role, project, space: t.labels["herdr.space"], sid: t.labels["claude.sid"], cwd: t.cwd, created: t.created_ms ?? 0, status: statusOf(t), file };
    });
  // Two terminals may claim the root for a moment while it is restarted; the newest one is it
  const root = sessions.filter((s) => s.role === "root").sort((a, b) => b.created - a.created)[0] ?? null;
  const names = new Set([...sessions.map((s) => s.project), ...[...files.keys()].map((k) => k.split("/")[0])]);
  names.delete(root?.project);
  const projects = [...names]
    .map((name) => {
      const lead = sessions.filter((s) => isLead(s.role) && s.project === name).sort((a, b) => b.created - a.created)[0] ?? null;
      const info = (lead?.file.title !== undefined ? lead.file : files.get(`${name}/${name}`)) ?? {};
      const workers = sessions.filter((s) => s.role === "worker" && s.project === name);
      return { name, title: info.title || name, order: info.order ?? Infinity, closed: info.closed, lead, workers, status: top([lead, ...workers].filter(Boolean)) };
    })
    .filter((p) => !p.closed && (p.lead || p.workers.length))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { root, projects, sessions };
}

// Where Cmd+Option+] and Cmd+Option+[ go from the focused terminal: the next or previous of the
// root and each project's lead, in sidebar order, wrapping at the ends. A worker counts as just
// below its lead, and a terminal outside the tree as below the last project.
export function stepLead(m, address, dir) {
  const stops = [m.root, ...m.projects.map((p) => p.lead)].map((s, at) => s && { s, at }).filter(Boolean);
  if (!stops.length) return null;
  const me = m.sessions.find((s) => s.address === address);
  const i = m.projects.findIndex((p) => p.name === me?.project);
  const at = me?.role === "root" ? 0 : i >= 0 ? i + 1 + (me.role === "worker" ? 0.5 : 0) : m.projects.length + 1;
  const pick = dir > 0 ? stops.find((x) => x.at > at) ?? stops[0] : [...stops].reverse().find((x) => x.at < at) ?? stops[stops.length - 1];
  return pick.s;
}
