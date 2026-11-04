// A work graph: the nodes a graph file lists, with live state from Linear, GitHub and the
// sessions' state files, the edges from each blocker to what it blocks, and a layout in columns
// by dependency depth and lanes.
//
// Graph file: { title, lanes: [lane names, top to bottom], nodes: [{ id, title, lane, after:
// [ids of its blockers], owner (a session name), status ("done"), asks: [ask ids], note, link,
// pr }] }. A node whose id is a Linear identifier (ABC-12) takes its title, state, parent and
// `blocks` relations from Linear, and its pull request from the issue's GitHub link unless `pr`
// names one. An id or `pr` of owner/repo#n is read from GitHub; a pull request whose base branch
// is another node's head branch is blocked by it. A parent issue waits on its sub-issues in the
// graph without an arrow, since it contains them.

import { exec, home, readTextFile } from "herdr";
import { readdir } from "fs/promises";

export const expand = (p) => (typeof p === "string" && p.startsWith("~") ? home() + p.slice(1) : p);

const LINEAR_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const PR_REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const DONE = ["completed", "canceled"];

export function prRef(s) {
  const m = PR_REF.exec(s ?? "") ?? PR_URL.exec(s ?? "");
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}

export async function readGraph(path) {
  try {
    const text = await readTextFile(expand(path));
    if (text == null) return { path, error: `No file at ${path}` };
    return { path, data: JSON.parse(text) };
  } catch (e) {
    return { path, error: `Could not read ${path}: ${e?.message ?? e}` };
  }
}

// Every session's state file under the projects folder, as `<project>/<session>`
export async function readFiles(folder) {
  const files = new Map();
  let dirs = [];
  try {
    dirs = await readdir(folder, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || /^[._]/.test(d.name)) continue;
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

export const linearIds = (graphs) => [...new Set(graphs.flatMap((g) => g.data?.nodes ?? []).map((n) => n?.id).filter((id) => LINEAR_ID.test(id ?? "")))];

// One Linear call for every issue, through the `linear` CLI's own login
export async function fetchLinear(ids) {
  if (!ids.length) return { issues: new Map() };
  const fields = "identifier title url state{type name} parent{identifier} relations{nodes{type relatedIssue{identifier}}} attachments{nodes{url}}";
  const query = `query{${ids.map((id, i) => `i${i}:issue(id:${JSON.stringify(id)}){${fields}}`).join(" ")}}`;
  const r = await exec("linear", ["api", query]);
  let data = {};
  try {
    data = JSON.parse(r.stdout || "{}").data ?? {};
  } catch {
    // Reported below
  }
  const issues = new Map();
  ids.forEach((id, i) => {
    const x = data[`i${i}`];
    if (x) issues.set(id, {
      title: x.title, url: x.url, state: x.state?.type, stateName: x.state?.name, parent: x.parent?.identifier ?? null,
      blocks: (x.relations?.nodes ?? []).filter((n) => n.type === "blocks").map((n) => n.relatedIssue?.identifier).filter(Boolean),
      prs: (x.attachments?.nodes ?? []).map((a) => prRef(a.url)).filter(Boolean),
    });
  });
  const error = issues.size || !ids.length ? null : (r.stderr?.trim().split("\n")[0] || `linear exited ${r.code}`);
  return { issues, error };
}

const nodePr = (n, issue) => prRef(n.pr) ?? (PR_REF.test(n.id) ? n.id : null) ?? issue?.prs?.[0] ?? null;

export const prRefs = (graphs, issues) => [...new Set(graphs.flatMap((g) => g.data?.nodes ?? []).filter((n) => n?.id).map((n) => nodePr(n, issues.get(n.id))).filter(Boolean))];

export async function fetchPrs(refs) {
  if (!refs.length) return { prs: new Map() };
  const parts = refs.map((ref, i) => {
    const [, owner, repo, number] = PR_REF.exec(ref);
    return `p${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}){pullRequest(number:${number}){title url state isDraft baseRefName headRefName}}`;
  });
  const r = await exec("gh", ["api", "graphql", "-f", `query=query{${parts.join(" ")}}`]);
  let data = {};
  try {
    data = JSON.parse(r.stdout || "{}").data ?? {};
  } catch {
    // Reported below
  }
  const prs = new Map();
  refs.forEach((ref, i) => {
    const x = data[`p${i}`]?.pullRequest;
    if (x) prs.set(ref, { title: x.title, url: x.url, state: x.state, draft: x.isDraft, base: x.baseRefName, head: x.headRefName });
  });
  const error = prs.size ? null : (r.stderr?.trim().split("\n")[0] || `gh exited ${r.code}`);
  return { prs, error };
}

// Open asks from every state file, with the text they are matched on
export function openAsks(files) {
  const asks = [];
  for (const [key, f] of files) {
    for (const a of Array.isArray(f.asks) ? f.asks : []) {
      if (a?.status !== "open") continue;
      asks.push({ id: a.id, key, text: [a.ask, a.context, a.title].filter((x) => typeof x === "string").join(" ") });
    }
  }
  return asks;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Sessions by name: a terminal's own name, else its tab's
export function liveSessions(terminals, spaces) {
  const tabs = new Map(spaces.flatMap((sp) => sp.tabs.filter((tab) => tab.named).map((tab) => [tab.id, tab.name])));
  const out = new Map();
  for (const t of terminals) {
    if (t.state !== "live") continue;
    const name = t.name || tabs.get(t.labels?.["herdr.tab"]);
    if (name) out.set(name, { address: t.address, status: t.status === "error" ? "blocked" : t.status });
  }
  return out;
}

// The order statuses are counted and colored in, most pressing first
export const STATES = ["needs", "ready", "flight", "blocked", "done"];

export function build(data, issues, prs, asks, sessions) {
  const raw = (data?.nodes ?? []).filter((n) => n && typeof n.id === "string");
  const ids = new Set(raw.map((n) => n.id));
  const nodes = raw.map((n, index) => {
    const issue = issues.get(n.id) ?? null;
    const pr = nodePr(n, issue);
    const live = pr ? prs.get(pr) ?? null : null;
    const title = n.title ?? issue?.title ?? live?.title?.replace(/^[A-Z][A-Z0-9]*-\d+\s+/, "") ?? n.id;
    const done = n.status === "done" || DONE.includes(issue?.state) || live?.state === "MERGED";
    return { ...n, index, issue, pr, live, title, done, lane: n.lane ?? data.title ?? "" };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = new Map();
  const edge = (from, to, kind) => {
    if (from !== to && byId.has(from) && byId.has(to) && !edges.has(`${from}>${to}`)) edges.set(`${from}>${to}`, { from, to, kind });
  };
  for (const n of nodes) {
    for (const a of Array.isArray(n.after) ? n.after : []) edge(a, n.id, "after");
    for (const b of n.issue?.blocks ?? []) edge(n.id, b, "blocks");
    if (n.issue?.parent && ids.has(n.issue.parent)) edge(n.id, n.issue.parent, "contains");
    if (n.live?.base) {
      const repo = n.pr.split("#")[0];
      const below = nodes.find((m) => m !== n && m.live?.head === n.live.base && m.pr.split("#")[0] === repo);
      if (below) edge(below.id, n.id, "stack");
    }
  }
  const preds = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges.values()) preds.get(e.to).push(e.from);

  for (const n of nodes) {
    n.blockers = preds.get(n.id).map((id) => byId.get(id)).filter((m) => !m.done);
    // Only an issue id or a PR number is distinctive enough to find in an ask's text
    const refs = [LINEAR_ID.test(n.id) ? n.id : null, n.pr ? `#${n.pr.split("#")[1]}` : null].filter(Boolean);
    const pattern = refs.length ? new RegExp(refs.map((r) => `(^|[^\\w])${escape(r)}(?![\\w])`).join("|")) : null;
    n.waiting = Array.isArray(n.asks) ? asks.filter((a) => n.asks.includes(a.id)) : asks.filter((a) => pattern?.test(a.text));
    n.session = n.owner ? sessions.get(n.owner) ?? null : null;
    n.state = n.done ? "done" : n.waiting.length ? "needs" : n.session ? "flight" : n.blockers.length ? "blocked" : "ready";
  }

  // Columns: the longest chain of blockers before a node
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = preds.get(id).reduce((m, p) => Math.max(m, depthOf(p) + 1), 0);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => (n.col = depthOf(n.id)));

  const lanes = [...new Set([...(Array.isArray(data.lanes) ? data.lanes : []), ...nodes.map((n) => n.lane)])]
    .filter((l) => nodes.some((n) => n.lane === l));
  const laneIndex = new Map(lanes.map((l, i) => [l, i]));
  const rows = new Map(lanes.map((l) => [l, 0]));
  const cols = nodes.reduce((m, n) => Math.max(m, n.col + 1), 0);
  // Within a lane and column, a node sits near the blockers it follows, so arrows cross less
  const key = (n) => laneIndex.get(n.lane) * 1000 + n.row;
  for (let c = 0; c < cols; c++) {
    for (const lane of lanes) {
      const here = nodes.filter((n) => n.col === c && n.lane === lane);
      const mean = (n) => {
        const ps = preds.get(n.id).map((id) => byId.get(id)).filter((m) => m.row !== undefined);
        return ps.length ? ps.reduce((s, m) => s + key(m), 0) / ps.length : Infinity;
      };
      here.map((n) => [n, mean(n)]).sort((a, b) => a[1] - b[1] || a[0].index - b[0].index).forEach(([n], i) => (n.row = i));
      rows.set(lane, Math.max(rows.get(lane), here.length));
    }
  }
  // An arrow that another path already implies is not drawn, so a blocker points only at its
  // nearest dependents
  const next = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges.values()) next.get(e.from).push(e.to);
  const reaches = (from, to, skip) => {
    const seen = new Set();
    const stack = next.get(from).filter((id) => id !== skip);
    while (stack.length) {
      const id = stack.pop();
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...next.get(id));
    }
    return false;
  };
  const drawn = [...edges.values()].filter((e) => e.kind !== "contains" && !reaches(e.from, e.to, e.to));
  return { nodes, byId, edges: drawn, lanes: lanes.map((name) => ({ name, rows: rows.get(name) })), cols };
}
