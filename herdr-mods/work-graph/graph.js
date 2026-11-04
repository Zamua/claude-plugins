// All tracked work as a tree of nodes with blocker edges: a node per open project (from its
// coordinator's state file), then the nodes in that project's graph file, nested by `parent`.
//
// Graph file: <projects folder>/<project>/graph.json, or the path in the coordinator's `graph`
// field, as { nodes: [{ id, title (a word or two), kind (one word), summary (five to seven words),
// parent, blockedBy: [ids], status (one of FILE_STATUS: "parked" is work deliberately deferred, and
// any other word is reported on the node rather than read as one of these), owner (a
// session name, the person's own name, or "team:<name>"), asks: [ask ids], note, link,
// links: [{ label, url }] (a URL or a file path), pr }] }. A node without a parent sits directly under its
// project. A blocker id is a node of the same file, or a Linear id or owner/repo#n, which are the
// same node everywhere. Each project is its own DAG: a blocker in another project, such as
// `<project>/<id>`, is drawn nowhere and reported on the node that names it. A Linear node takes its title,
// state, sub-issues and `blocks` relations from Linear, and its pull request from the issue's
// GitHub link unless `pr` names one; a listed issue's sub-issues join under it unless a file
// lists them. A pull request whose base branch is another node's head branch merges after it: that
// edge orders the stack and blocks nothing. A node's blockers also block everything inside it.

import { exec, home, readTextFile } from "herdr";
import { readdir } from "fs/promises";

export const expand = (p) => (typeof p === "string" && p.startsWith("~") ? home() + p.slice(1) : p);

const LINEAR_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const PR_REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const DONE = ["completed", "canceled"];
const GRAPH = "graph.json";

const isGlobal = (id) => LINEAR_ID.test(id) || PR_REF.test(id);

export function prRef(s) {
  const m = PR_REF.exec(s ?? "") ?? PR_URL.exec(s ?? "");
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}

// Every session's state file under the projects folder, as `<project>/<session>`; a graph file
// is not one
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
    for (const n of names.filter((n) => n.endsWith(".json") && n !== GRAPH)) {
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

// Open projects in their order: those whose coordinator file has a `title` and isn't closed
export function projectList(folder, files, rootProject) {
  const names = [...new Set([...files.keys()].map((k) => k.split("/")[0]))];
  const out = [];
  for (const name of names) {
    if (name === rootProject) continue;
    const own = files.get(`${name}/${name}`);
    const [key, lead] = own?.title !== undefined ? [`${name}/${name}`, own]
      : [...files].find(([k, f]) => k.startsWith(`${name}/`) && f.title !== undefined) ?? [];
    if (!lead || lead.closed) continue;
    out.push({
      name, title: lead.title || name, order: lead.order ?? Infinity, lead: key.split("/")[1],
      goal: lead.goal, next: Array.isArray(lead.next) ? lead.next[0] : lead.next,
      graph: lead.graph ? expand(lead.graph) : `${folder}/${name}/${GRAPH}`,
    });
  }
  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export async function readGraph(path) {
  try {
    const text = await readTextFile(path);
    if (text == null) return { missing: true };
    return { data: JSON.parse(text) };
  } catch (e) {
    return { error: `Could not read ${path}: ${e?.message ?? e}` };
  }
}

const fileNodes = (graphs) => [...graphs.values()].flatMap((g) => (Array.isArray(g?.data?.nodes) ? g.data.nodes : [])).filter((n) => n && typeof n.id === "string");

export const linearIds = (graphs) => [...new Set(fileNodes(graphs).map((n) => n.id).filter((id) => LINEAR_ID.test(id)))];

const ISSUE = "identifier title url state{type name} team{name} parent{identifier} relations{nodes{type relatedIssue{identifier}}} attachments{nodes{url}}";

function issueOf(x) {
  return {
    title: x.title, url: x.url, state: x.state?.type, stateName: x.state?.name, team: x.team?.name ?? null, parent: x.parent?.identifier ?? null,
    blocks: (x.relations?.nodes ?? []).filter((n) => n.type === "blocks").map((n) => n.relatedIssue?.identifier).filter(Boolean),
    prs: (x.attachments?.nodes ?? []).map((a) => prRef(a.url)).filter(Boolean),
    children: [],
  };
}

async function askLinear(ids) {
  const query = `query{${ids.map((id, i) => `i${i}:issue(id:${JSON.stringify(id)}){${ISSUE} children{nodes{${ISSUE}}}}`).join(" ")}}`;
  const r = await exec("linear", ["api", query]);
  let body = {};
  try {
    body = JSON.parse(r.stdout || "{}");
  } catch {
    // Reported by the caller
  }
  return { r, data: body.data ?? null, notFound: (body.errors ?? []).some((e) => /not found/i.test(e.message ?? "")) };
}

// One Linear call for every listed issue and its sub-issues, through the `linear` CLI's own login.
// An id Linear doesn't know (an id from another tracker) fails the whole call, so the ids are
// then asked one by one, and the unknown ones come back as `missing` to leave out next time.
export async function fetchLinear(ids) {
  if (!ids.length) return { issues: new Map(), missing: [] };
  let answers = [];
  const batch = await askLinear(ids);
  if (batch.data) answers = ids.map((id, i) => [id, batch.data[`i${i}`]]);
  else if (batch.notFound) answers = await Promise.all(ids.map(async (id) => [id, (await askLinear([id])).data?.i0 ?? null]));
  const issues = new Map();
  const missing = [];
  for (const [id, x] of answers) {
    if (!x) {
      missing.push(id);
      continue;
    }
    const issue = issueOf(x);
    for (const c of x.children?.nodes ?? []) {
      issue.children.push(c.identifier);
      if (!issues.has(c.identifier)) issues.set(c.identifier, issueOf(c));
    }
    issues.set(id, issue);
  }
  const error = issues.size ? null : (batch.r.stderr?.trim().split("\n")[0] || `linear exited ${batch.r.code}`);
  return { issues, missing: issues.size ? missing : [], error };
}

const nodePr = (raw, id, issue) => prRef(raw?.pr) ?? (PR_REF.test(id) ? id : null) ?? issue?.prs?.[0] ?? null;

export function prRefs(graphs, issues) {
  const refs = fileNodes(graphs).map((n) => nodePr(n, n.id, issues.get(n.id)));
  for (const issue of issues.values()) refs.push(issue.prs[0]);
  return [...new Set(refs.filter(Boolean))];
}

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

export function openAsks(files) {
  const asks = [];
  for (const [key, f] of files) {
    for (const a of Array.isArray(f.asks) ? f.asks : []) {
      if (a?.status !== "open") continue;
      asks.push({ id: a.id, key: `${key}#${a.id}`, project: key.split("/")[0], text: [a.ask, a.context, a.title].filter((x) => typeof x === "string").join(" ") });
    }
  }
  return asks;
}

// Live sessions by name (a terminal's own name, else its tab's), and the projects with any
// Agent processes that each publish a record, <pid>.json with a status word
export async function readRecords(folder) {
  const out = new Map();
  let names = [];
  try {
    names = await readdir(folder);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    try {
      const r = JSON.parse((await readTextFile(`${folder}/${name}`)) ?? "null");
      if (r?.pid && r.status) out.set(Number(r.pid), r.status);
    } catch {
      // A record mid-write is read again on its next change
    }
  }
  return out;
}

// An agent between turns whose record says "shell" has a background job running or a wake set,
// so it is waiting on itself rather than idle
export function liveSessions(terminals, spaces, records = new Map()) {
  const tabs = new Map(spaces.flatMap((sp) => sp.tabs.filter((tab) => tab.named).map((tab) => [tab.id, tab.name])));
  const byName = new Map();
  const projects = new Map();
  for (const t of terminals) {
    if (t.state !== "live") continue;
    const between = !["working", "blocked", "error"].includes(t.status);
    const pending = between && records.get(t.foreground?.pid ?? t.pid) === "shell";
    const s = { address: t.address, status: t.status === "error" ? "blocked" : pending ? "waiting" : t.status };
    const name = t.name || tabs.get(t.labels?.["herdr.tab"]);
    if (name) byName.set(name, s);
    const p = t.labels?.["tree.project"];
    if (p && t.labels?.["tree.role"]) projects.set(p, [...(projects.get(p) ?? []), s]);
  }
  return { byName, projects };
}

// Unblocked work that isn't done, by who can take it next: `me` is the person's owner name and
// `team` their own team's name in Linear, so an owner "team:<name>", or an unowned issue of
// another Linear team, waits on that team
export function startGroups(model, { me, team } = {}) {
  const groups = { start: [], you: [], teams: [] };
  for (const n of model.leaves) {
    if (n.kind === "project" || n.done || n.parked || n.blockers.length) continue;
    const owner = typeof n.owner === "string" ? n.owner : "";
    const other = owner.startsWith("team:") ? owner.slice(5) : !owner && team && n.issue?.team && n.issue.team !== team ? n.issue.team : null;
    if (n.waiting.length || (me && owner === me)) groups.you.push({ n });
    else if (other) groups.teams.push({ n, team: other });
    else if (n.state === "ready") groups.start.push({ n });
  }
  return groups;
}

export const rootProject = (terminals) => terminals.filter((t) => t.state === "live" && t.labels?.["tree.role"] === "root")
  .sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0))[0]?.labels?.["tree.project"] ?? "root";

// The words a graph file's status may use; needs you and blocked come from asks and blockers
export const FILE_STATUS = ["todo", "in-progress", "parked", "done"];

// Most urgent first: a group shows the first one anything inside it has
export const STATES = ["needs", "flight", "waiting", "ready", "idle", "blocked", "parked", "done"];

const shortName = (s, words) => {
  const w = String(s ?? "").replace(/\s*\([^)]*\)\s*/g, " ").trim().split(/\s+/).filter(Boolean);
  return w.length <= words ? w.join(" ") : `${w.slice(0, words).join(" ")}…`;
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function build({ projects, graphs, issues, prs, asks, sessions }) {
  const nodes = new Map();
  const add = (key, n) => {
    if (!nodes.has(key)) nodes.set(key, { key, children: [], ...n });
    return nodes.get(key);
  };
  for (const p of projects) {
    add(`@${p.name}`, { id: p.name, project: p.name, kind: "project", info: p, raw: { owner: p.lead, note: p.goal }, error: graphs.get(p.name)?.error });
  }
  const listed = [];
  for (const p of projects) {
    for (const raw of Array.isArray(graphs.get(p.name)?.data?.nodes) ? graphs.get(p.name).data.nodes : []) {
      if (!raw || typeof raw.id !== "string" || !raw.id) continue;
      const key = isGlobal(raw.id) ? raw.id : `${p.name}/${raw.id}`;
      if (nodes.has(key)) continue;
      listed.push(add(key, { id: raw.id, project: p.name, raw }));
    }
  }
  for (const n of listed) {
    for (const c of issues.get(n.key)?.children ?? []) if (!nodes.has(c)) add(c, { id: c, project: n.project, raw: {}, linearParent: n.key });
  }

  const resolve = (ref, project) => {
    if (typeof ref !== "string" || !ref) return null;
    if (isGlobal(ref)) return nodes.has(ref) ? ref : null;
    if (nodes.has(`${project}/${ref}`)) return `${project}/${ref}`;
    if (ref.includes("/") && nodes.has(ref)) return ref;
    return nodes.has(`@${ref}`) ? `@${ref}` : null;
  };

  for (const n of nodes.values()) {
    if (n.kind === "project") continue;
    const issue = issues.get(n.key);
    const linear = n.linearParent ?? (issue?.parent && nodes.get(issue.parent)?.project === n.project ? issue.parent : null);
    n.parent = resolve(n.raw.parent, n.project) ?? linear ?? `@${n.project}`;
  }
  // A parent chain that loops is cut at the project
  for (const n of nodes.values()) {
    const seen = new Set([n.key]);
    for (let p = n.parent; p && !p.startsWith("@"); p = nodes.get(p).parent) {
      if (seen.has(p)) {
        n.parent = `@${n.project}`;
        break;
      }
      seen.add(p);
    }
  }
  for (const n of nodes.values()) if (n.parent) nodes.get(n.parent).children.push(n.key);
  const levelOf = (n) => (n.parent ? levelOf(nodes.get(n.parent)) + 1 : 0);
  const ancestors = (key) => {
    const out = [];
    for (let p = nodes.get(key).parent; p; p = nodes.get(p).parent) out.push(p);
    return out;
  };

  for (const n of nodes.values()) {
    n.level = levelOf(n);
    n.ancestors = ancestors(n.key);
    n.issue = issues.get(n.key) ?? null;
    n.pr = n.kind === "project" ? null : nodePr(n.raw, n.id, n.issue);
    n.live = n.pr ? prs.get(n.pr) ?? null : null;
    const live = n.issue?.title ?? n.live?.title?.replace(/^[A-Z][A-Z0-9]*-\d+\s+/, "") ?? null;
    const long = n.kind === "project" ? n.info.title : n.raw.title ?? live ?? n.id;
    // A card's title is a word or two; a longer one, or none, is cut down so the gap shows
    n.title = n.kind === "project" ? shortName(n.info.title, 3) : shortName(n.raw.title ?? n.id, 2);
    n.fullTitle = live ?? long;
    n.tag = n.kind === "project" ? "project" : typeof n.raw.kind === "string" ? n.raw.kind : null;
    n.summary = n.kind === "project" ? n.info.goal ?? "" : n.raw.summary ?? (n.fullTitle !== n.title ? n.fullTitle : "");
    n.owner = n.raw.owner ?? null;
    n.note = n.raw.note ?? null;
    n.link = n.issue?.url ?? n.live?.url ?? n.raw.link ?? null;
    n.marked = n.raw.status === "done" || DONE.includes(n.issue?.state) || n.live?.state === "MERGED";
  }

  const base = new Map();
  // "block": can't start until `from` is done; "stack": merges after `from`, which blocks nothing
  const edge = (from, to, kind = "block") => {
    if (!from || !to || from === to || nodes.get(from).project !== nodes.get(to).project) return;
    const k = `${from}>${to}`;
    base.set(k, { from, to, kind: base.get(k)?.kind === "block" ? "block" : kind });
  };
  for (const n of nodes.values()) n.problems = [];
  for (const n of nodes.values()) {
    if (n.kind === "project") continue;
    for (const b of [].concat(n.raw.blockedBy ?? [], n.raw.after ?? [])) {
      const from = resolve(b, n.project);
      const named = typeof b === "string" && !isGlobal(b) && b.includes("/") ? b.split("/")[0] : null;
      const project = from ? nodes.get(from).project : named;
      if (project && project !== n.project) n.problems.push(`Blocked by ${b}, in another lane: each lane is its own graph, so it isn't drawn`);
      else edge(from, n.key);
    }
    for (const b of n.issue?.blocks ?? []) edge(n.key, nodes.has(b) ? b : null);
    if (n.live?.base) {
      const repo = n.pr.split("#")[0];
      const below = [...nodes.values()].find((m) => m !== n && m.live?.head === n.live.base && m.pr.split("#")[0] === repo);
      if (below) edge(below.key, n.key, "stack");
    }
  }
  const preds = new Map([...nodes.keys()].map((k) => [k, []]));
  for (const e of base.values()) if (e.kind === "block") preds.get(e.to).push(e.from);

  const leavesOf = (key) => {
    const n = nodes.get(key);
    return n.children.length ? n.children.flatMap(leavesOf) : [key];
  };
  const done = new Map();
  const doneOf = (key) => {
    if (!done.has(key)) {
      const n = nodes.get(key);
      done.set(key, n.marked || (n.children.length > 0 && leavesOf(key).every((k) => doneOf(k))));
    }
    return done.get(key);
  };

  const matched = new Set();
  for (const n of nodes.values()) {
    if (n.kind === "project") continue;
    const refs = [LINEAR_ID.test(n.id) ? n.id : null, n.pr ? `#${n.pr.split("#")[1]}` : null].filter(Boolean);
    const pattern = refs.length ? new RegExp(refs.map((r) => `(^|[^\\w])${escape(r)}(?![\\w])`).join("|")) : null;
    n.waiting = Array.isArray(n.raw.asks) ? asks.filter((a) => n.raw.asks.includes(a.id)) : asks.filter((a) => pattern?.test(a.text));
    for (const a of n.waiting) matched.add(a.key);
  }
  // A project's own open asks that name none of its nodes wait on the project itself
  for (const n of nodes.values()) if (n.kind === "project") n.waiting = asks.filter((a) => a.project === n.project && !matched.has(a.key));

  for (const n of nodes.values()) {
    n.done = doneOf(n.key);
    n.blockers = [...new Set([n.key, ...n.ancestors].flatMap((k) => preds.get(k)))].filter((k) => !doneOf(k)).map((k) => nodes.get(k));
    const own = sessions.projects.get(n.project) ?? [];
    n.session = n.kind === "project" ? own.find((s) => s.status === "working") ?? own.find((s) => s.status === "waiting") ?? own[0] ?? null
      : n.owner ? sessions.byName.get(n.owner) ?? null : null;
  }
  for (const n of nodes.values()) n.parked = !n.done && [n.key, ...n.ancestors].some((k) => nodes.get(k).raw?.status === "parked");
  for (const n of nodes.values()) {
    if (n.children.length) continue;
    // A live owner that isn't working holds the node without moving it
    const working = n.session?.status === "working" || n.raw?.status === "in-progress" || n.live?.state === "OPEN";
    n.state = n.done ? "done" : n.parked ? "parked" : n.waiting.length ? "needs" : working ? "flight" : n.session?.status === "waiting" ? "waiting"
      : n.blockers.length ? "blocked" : n.session ? "idle" : "ready";
  }
  // A group rolls up its leaves; its own open asks count as one more that needs you
  for (const n of nodes.values()) {
    if (!n.children.length) continue;
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    const leaves = leavesOf(n.key);
    for (const k of leaves) counts[nodes.get(k).state]++;
    n.total = leaves.length;
    if (n.waiting.length && !n.done) counts.needs++;
    n.counts = counts;
    n.state = n.done ? "done" : STATES.find((s) => counts[s] > 0) ?? "done";
  }

  // blockedBy means "can't start until it is done", so work in progress, waiting or done first, or
  // a node waiting on its own parent or child, is a mistake in the graph file to show, not to hide.
  // An open ask on blocked work is fine: a question can be answered ahead of the work.
  const names = (list) => list.map((b) => b.title).join(", ");
  for (const n of nodes.values()) {
    const s = n.raw?.status;
    if (s != null && !FILE_STATUS.includes(s)) n.problems.push(`Status "${s}" isn't a word the graph reads: use ${FILE_STATUS.join(", ")}`);
  }
  for (const n of nodes.values()) {
    if (n.kind === "project" || n.parked || !n.blockers.length) continue;
    const own = n.children.length ? null : n.raw?.status === "in-progress" || n.live?.state === "OPEN" ? "working" : n.session?.status;
    const started = n.done ? "Done" : own === "working" ? "In progress" : own === "waiting" ? "Waiting" : null;
    if (started) n.problems.push(`${started} while ${names(n.blockers)} ${n.blockers.length > 1 ? "aren't" : "isn't"} done`);
  }
  for (const e of base.values()) {
    if (e.kind !== "block") continue;
    const to = nodes.get(e.to);
    const from = nodes.get(e.from);
    if (to.ancestors.includes(e.from)) to.problems.push(`Blocked by ${from.title}, which holds it`);
    else if (from.ancestors.includes(e.to)) to.problems.push(`Blocked by ${from.title}, inside it`);
  }
  // A collapsed card shows the problems of everything inside it
  for (const n of nodes.values()) n.flagged = [];
  for (const n of nodes.values()) if (n.problems.length) for (const k of [n.key, ...n.ancestors]) nodes.get(k).flagged.push(n.key);
  return { nodes, base: [...base.values()], projects: projects.map((p) => `@${p.name}`), leaves: [...nodes.values()].filter((n) => !n.children.length) };
}

// What a given expansion shows: cards (collapsed nodes and leaves), frames (expanded nodes, a
// project's being its lane), and one edge between two shown nodes for every base edge between
// what they hold, with the base edges it stands for. An edge another path already implies is
// not drawn.
export function visible(model, isOpen) {
  const { nodes } = model;
  const opened = (n) => n.children.length > 0 && isOpen(n);
  const cards = [];
  const frames = [];
  const walk = (key) => {
    const n = nodes.get(key);
    if (opened(n)) {
      frames.push(key);
      n.children.forEach(walk);
    } else cards.push(key);
  };
  model.projects.forEach(walk);
  const repOf = (key) => {
    const chain = [...nodes.get(key).ancestors].reverse().concat(key);
    return chain.find((k) => !opened(nodes.get(k))) ?? key;
  };
  const within = (a, b) => a === b || nodes.get(b).ancestors.includes(a) || nodes.get(a).ancestors.includes(b);
  const agg = new Map();
  for (const e of model.base) {
    const from = repOf(e.from);
    const to = repOf(e.to);
    if (within(from, to)) continue;
    const k = `${from}>${to}`;
    agg.set(k, { key: k, from, to, list: [...(agg.get(k)?.list ?? []), e] });
  }
  // A blocker arrow is implied only by a chain of blocker arrows, since a merge-order arrow blocks
  // nothing; a merge-order arrow is implied by any chain
  const blocks = (e) => e.list.some((b) => b.kind === "block");
  const nextAll = new Map();
  const nextBlock = new Map();
  for (const e of agg.values()) {
    nextAll.set(e.from, [...(nextAll.get(e.from) ?? []), e.to]);
    if (blocks(e)) nextBlock.set(e.from, [...(nextBlock.get(e.from) ?? []), e.to]);
  }
  const reaches = (from, to, next) => {
    const seen = new Set();
    const stack = (next.get(from) ?? []).filter((id) => id !== to);
    while (stack.length) {
      const id = stack.pop();
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    return false;
  };
  // An edge into a node a frame contains is already said by an edge into the frame from the same
  // place (a blocker of a step blocks all of it), and likewise out of one; the general edge
  // stays and takes the other's base edges
  const self = (k) => [k, ...nodes.get(k).ancestors];
  const general = [...agg.values()].sort((x, y) => nodes.get(x.from).ancestors.length + nodes.get(x.to).ancestors.length
    - nodes.get(y.from).ancestors.length - nodes.get(y.to).ancestors.length);
  const kept = [];
  for (const e of general) {
    const over = kept.find((k) => k !== e && self(e.from).includes(k.from) && self(e.to).includes(k.to));
    if (over) over.list = [...over.list, ...e.list];
    else kept.push({ ...e });
  }
  const edges = kept.filter((e) => !reaches(e.from, e.to, blocks(e) ? nextBlock : nextAll)).map((e) => ({ ...e, stack: !blocks(e) }));

  // Columns: the longest chain of shown blockers before a card; an edge into a frame comes
  // before everything in it, and one out of a frame after everything in it
  const cardSet = new Set(cards);
  const cardsIn = (key) => (cardSet.has(key) ? [key] : cards.filter((c) => nodes.get(c).ancestors.includes(key)));
  const cardPreds = new Map(cards.map((c) => [c, new Set()]));
  for (const e of agg.values()) {
    const sources = cardsIn(e.from);
    for (const c of cardsIn(e.to)) sources.forEach((s) => cardPreds.get(c).add(s));
  }
  const col = new Map();
  const visiting = new Set();
  const colOf = (c) => {
    if (col.has(c)) return col.get(c);
    if (visiting.has(c)) return 0;
    visiting.add(c);
    const d = [...cardPreds.get(c)].reduce((m, p) => Math.max(m, colOf(p) + 1), 0);
    visiting.delete(c);
    col.set(c, d);
    return d;
  };
  cards.forEach(colOf);
  return { cards, frames, edges, col, cardPreds };
}

// Everything one node waits on and everything that waits on it, followed through containment: a
// blocker of a step blocks all of it, and waiting on a step is waiting on all of it. Gives the
// nodes on that path with every node that holds one, and the base edges it runs along.
export function pathOf(model, key) {
  const { nodes } = model;
  if (!nodes.has(key)) return null;
  const into = new Map();
  const out = new Map();
  for (const e of model.base) {
    into.set(e.to, [...(into.get(e.to) ?? []), e]);
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
  }
  const inside = (k) => [k, ...nodes.get(k).children.flatMap(inside)];
  const start = inside(key);
  const on = new Set(start);
  const edges = new Set();
  const walk = (index, end) => {
    const seen = new Set(start);
    const asked = new Set();
    const stack = [...start];
    while (stack.length) {
      const k = stack.pop();
      for (const a of [k, ...nodes.get(k).ancestors]) {
        if (asked.has(a)) continue;
        asked.add(a);
        for (const e of index.get(a) ?? []) {
          edges.add(`${e.from}>${e.to}`);
          for (const m of inside(e[end])) {
            if (seen.has(m)) continue;
            seen.add(m);
            on.add(m);
            stack.push(m);
          }
        }
      }
    }
  };
  walk(into, "from");
  walk(out, "to");
  const lit = new Set();
  for (const k of on) for (const a of [k, ...nodes.get(k).ancestors]) lit.add(a);
  return { lit, edges };
}
