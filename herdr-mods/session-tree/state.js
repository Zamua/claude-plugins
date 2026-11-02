// The session tree: terminals labelled tree.role, tree.project and tree.parent, joined to
// the state file each session keeps at <folder>/<project>/<session>.json.

import { readTextFile, home, terminals } from "herdr";
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
    for (const n of names.filter((n) => n.endsWith(".json"))) {
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

const statusOf = (t) => (t.status === "error" ? "blocked" : RANK[t.status] ? t.status : "idle");
const top = (list) => list.reduce((m, s) => (RANK[s.status] > RANK[m] ? s.status : m), "idle");

export function model(files) {
  const sessions = terminals()
    .filter((t) => t.state === "live" && t.labels?.["tree.role"])
    .map((t) => {
      const project = t.labels["tree.project"] ?? "";
      const file = files.get(`${project}/${t.name}`) ?? {};
      const asks = (file.asks ?? []).filter((a) => a?.status === "open");
      const status = statusOf(t);
      return { name: t.name, address: t.address, role: t.labels["tree.role"], project, status, file, asks, needs: status === "blocked" || asks.length > 0 };
    });
  const root = sessions.find((s) => s.role === "root") ?? null;
  const names = new Set([...sessions.map((s) => s.project), ...[...files.keys()].map((k) => k.split("/")[0])]);
  names.delete(root?.project);
  const projects = [...names]
    .map((name) => {
      const lead = sessions.find((s) => s.role === "project" && s.project === name) ?? null;
      const info = files.get(`${name}/${lead?.name ?? name}`) ?? {};
      const workers = sessions.filter((s) => s.role === "worker" && s.project === name);
      return { name, title: info.title || name, order: info.order ?? Infinity, closed: info.closed, lead, workers, status: top([lead, ...workers].filter(Boolean)) };
    })
    .filter((p) => !p.closed && (p.lead || p.workers.length))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { root, projects, sessions };
}

/** What needs the person: every open ask, then every session waiting on a dialog. */
export function needs({ sessions }) {
  return [
    ...sessions.filter((s) => s.status === "blocked").map((s) => ({ s, ask: null })),
    ...sessions.flatMap((s) => s.asks.map((ask) => ({ s, ask }))),
  ];
}
