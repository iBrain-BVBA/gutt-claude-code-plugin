#!/usr/bin/env node
/**
 * vault-pages: data files and page copies for a vault's shareable pages.
 *
 *   export   episodes, nodes and facts read from memory → graph.json and timeline.json
 *   prepare  a template's index.html with the vault's <title>, plus its data file, in one folder
 *   check    a brief.json, graph.json or timeline.json against its contract
 *   preview  serve a template on localhost with its fixture (or your data file)
 *
 * Zero dependencies, Node.js 18 or later. Run `node vault-pages.cjs help` for the options.
 *
 * The export never calls memory itself: the vault-pages skill reads the vault group through
 * the memory connector and hands this script what came back, as one combined export.json or
 * as a folder of the raw tool results. Everything here is deterministic: the same input (and
 * the same previous graph.json) gives the same layout and data, whatever order it was read in,
 * so weekly re-exports keep the picture where it was. Only the export timestamps differ,
 * unless --now fixes them.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATES = path.join(PLUGIN_ROOT, "templates");
const PAGES = {
  brief: { data: "brief.json", suffix: "Brief" },
  graph: { data: "graph.json", suffix: "Graph" },
  timelapse: { data: "timeline.json", suffix: "Timelapse" },
  console: { data: null, suffix: "Console" },
};
const SCHEMA = 1;
const SCALE = 1000;
const SUMMARY_CAP = 1400;
const FACT_TEXT_CAP = 600;

/**
 * The vault's own agents, in the order the Timelapse lists them. Others follow by name.
 * `vault-curate` is a legacy identity: no skill registers it now, but older vaults' episodes
 * carry it, so their Timelapse keeps its place and label.
 */
const KNOWN_AGENTS = [
  "vault-charter",
  "vault-scout",
  "vault-librarian",
  "vault-reviewer",
  "vault-curate",
  "vault-brief",
];
const AGENT_ABOUT = {
  "vault-charter": "Holds the vault's charter and the owner's steering.",
  "vault-scout": "Researches one beat on the open web and returns candidate findings.",
  "vault-librarian": "Verifies candidates against their sources and records findings.",
  "vault-reviewer": "Judges pending rows from the owner's past verdicts.",
  "vault-curate": "Ran the daily research in older vaults (a legacy identity).",
  "vault-brief": "Writes the weekly brief and the reviewer's calibration.",
};

// ── reading the export ──────────────────────────────────────────────────────────

const DATA_KEYS = ["episodes", "nodes", "facts"];
const hasData = (b) => DATA_KEYS.some((k) => Array.isArray(b[k]));

/** An error result: the tool said so, or the body is only an error message. */
function isErrorBody(b) {
  return b.isError === true || (b.error !== undefined && b.error !== null && !hasData(b));
}

/**
 * A tool result as the host saved it: the JSON body itself, an MCP content array whose text
 * items hold the body, or `{result: body}` / `{payload: body}`. Returns the body, or null and
 * the reason in `why.reason`. One unreadable or error item makes the whole result unreadable:
 * keeping the rest would hide that a batch came back incomplete.
 */
function unwrap(value, why = {}) {
  let v = value;
  for (let depth = 0; depth < 4 && v !== null && v !== undefined; depth++) {
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        why.reason = "not JSON";
        return null;
      }
      continue;
    }
    if (Array.isArray(v)) {
      const texts = v.filter((c) => c && c.type === "text" && typeof c.text === "string");
      if (texts.length === v.length && texts.length) {
        const parts = [];
        for (const c of texts) {
          const part = unwrap(c.text, why);
          if (!part) {
            why.reason = why.reason === "not JSON" ? "a text item is not JSON" : why.reason;
            return null;
          }
          if (isErrorBody(part)) {
            why.reason = "an error result";
            return null;
          }
          parts.push(part);
        }
        return parts.length === 1 ? parts[0] : mergeBodies(parts);
      }
      why.reason = "not a tool result";
      return null;
    }
    if (typeof v === "object") {
      if (v.isError === true) {
        why.reason = "an error result";
        return null;
      }
      if (v.content && Array.isArray(v.content) && !v.episodes && !v.nodes && !v.facts) {
        v = v.content;
        continue;
      }
      if (v.result && typeof v.result === "object" && !v.episodes && !v.nodes) {
        v = v.result;
        continue;
      }
      if (v.payload && !v.episodes && !v.nodes) {
        v = v.payload;
        continue;
      }
      return v;
    }
    why.reason = "not a tool result";
    return null;
  }
  return v;
}

function mergeBodies(bodies) {
  const out = { episodes: [], nodes: [], facts: [] };
  for (const b of bodies) {
    for (const k of ["episodes", "nodes", "facts"]) {
      if (Array.isArray(b[k])) {
        out[k].push(...b[k]);
      }
    }
    if (b.vault && !out.vault) {
      out.vault = b.vault;
    }
    // get_episodes says has_more when the group holds more than it listed.
    if (b.has_more === true) {
      out.has_more = true;
    }
  }
  return out;
}

/** Every *.json or *.txt file under a folder, sorted, so a folder of saved tool results reads the same way twice. */
function jsonFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (/\.(json|txt)$/i.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/** The export as one object `{vault, episodes, nodes, facts}`, from a file or a folder. */
function readExport(input) {
  const stat = fs.statSync(input);
  const files = stat.isDirectory() ? jsonFiles(input) : [input];
  const bodies = [];
  const skipped = [];
  for (const f of files) {
    const why = {};
    const body = unwrap(fs.readFileSync(f, "utf8"), why);
    if (body && isErrorBody(body)) {
      skipped.push(`${f} (an error result)`);
    } else if (body && (hasData(body) || (body.vault && typeof body.vault === "object"))) {
      bodies.push(body);
    } else {
      skipped.push(`${f} (${why.reason || "no episodes, nodes or facts in it"})`);
    }
  }
  if (!bodies.length) {
    throw new Error(`${input}: no episodes, nodes or facts found`);
  }
  // A saved result the script can't read is reported, never silently left out of the pages.
  return Object.assign(mergeBodies(bodies), { skipped });
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/** FNV-1a, 32 bits, as a fraction in [0, 1): the layout's only source of "randomness". */
function hash01(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

/** A fact's id: its uuid, or its id. The same key everywhere a fact is looked up or drawn. */
const factId = (f) => String(f.uuid || f.id || "");

/** A stable order between two copies of one record, so a tie never depends on read order. */
function later(a, b) {
  return JSON.stringify(a) > JSON.stringify(b);
}

/** Of two reads of one fact, the one to keep: superseded beats current, then the later end. */
function newerFact(a, b) {
  const endA = a.invalid_at || a.expired_at || "";
  const endB = b.invalid_at || b.expired_at || "";
  if (!!endA !== !!endB) {
    return !!endA;
  }
  if (endA !== endB) {
    return (ms(endA) || 0) > (ms(endB) || 0);
  }
  return later(a, b);
}

const ms = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : null;
};

const STOP = new Set(
  "the and for with its from that this was are per not has have into of to in on by is a an as at or be it".split(
    " "
  )
);
function tokens(s) {
  const out = new Set();
  for (let w of String(s || "")
    .toLowerCase()
    .match(/[a-z0-9$%][a-z0-9$%.-]*/g) || []) {
    w = w.replace(/[.-]+$/, "");
    if (w.length >= 2 && !STOP.has(w)) {
      out.add(w);
    }
  }
  return out;
}

/** `vault_x:Type:Name` → `Type:Name`; anything else unchanged. */
function stripGroup(id, group) {
  const s = String(id || "");
  if (group && s.startsWith(group + ":")) {
    return s.slice(group.length + 1);
  }
  const m = s.match(/^vault_[a-z0-9_]+:(.+)$/);
  return m ? m[1] : s;
}

function nodeType(labels) {
  const l = (labels || []).filter((x) => x && x !== "Entity");
  return l[0] || "Entity";
}

/**
 * Who wrote an episode, and whether that was a guess. An explicit field wins; then the
 * episode's own text ("Recorded by vault-librarian", "Tagged vault-scout"); then its name
 * (`Run: vault-scout …`, `Charter: …`); else vault-librarian, as a default.
 */
function attribute(ep) {
  for (const k of ["agent", "agent_id", "agent_name"]) {
    if (typeof ep[k] === "string" && ep[k]) {
      return { agent: ep[k].split("--")[0], guessed: false };
    }
  }
  const meta = ep.episode_metadata || ep.metadata;
  if (meta && typeof meta === "object") {
    for (const k of ["agent_id", "agent", "agent_name"]) {
      if (typeof meta[k] === "string" && meta[k]) {
        return { agent: meta[k].split("--")[0], guessed: false };
      }
    }
  }
  const named = (agent) => ({ agent, guessed: false });
  const text = String(ep.content || "");
  const rec = text.match(/\b(?:Recorded|Tagged|Written)(?: by| as)? (vault-[a-z]+)/);
  if (rec) {
    return named(rec[1]);
  }
  const name = String(ep.name || "");
  const run = name.match(/^Run: (vault-[a-z]+)/);
  if (run) {
    return named(run[1]);
  }
  const fb = name.match(/^Feedback: (vault-[a-z]+) →/);
  if (fb) {
    return named(fb[1]);
  }
  if (/^(Charter|Steering|Config):/.test(name)) {
    return named("vault-charter");
  }
  if (/^(Brief|LinkedIn):/.test(name)) {
    return named("vault-brief");
  }
  if (/^Calibration:/.test(name)) {
    return named("vault-reviewer");
  }
  return { agent: "vault-librarian", guessed: true };
}

/** Who wrote an episode (see attribute). */
function episodeAgent(ep) {
  return attribute(ep).agent;
}

// ── layout ──────────────────────────────────────────────────────────────────────

/**
 * A force layout with fixed seeds. Nodes given a previous position stay exactly there; new
 * nodes start next to a placed neighbour, or on a seeded spot. Coordinates are in output
 * units, roughly [-SCALE, SCALE], so a previous export's positions are used as they are.
 *
 * @param {string[]} keys stable node keys
 * @param {Array<[number, number]>} edges index pairs
 * @param {Map<string, [number, number]>} pinned previous positions by key
 * @returns {Array<[number, number]>}
 */
function layout(keys, edges, pinned) {
  const n = keys.length;
  if (!n) {
    return [];
  }
  const k = (SCALE * 1.15) / Math.sqrt(Math.max(n, 4));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const fixed = new Uint8Array(n);
  const adj = keys.map(() => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const placed = new Uint8Array(n);
  keys.forEach((key, i) => {
    const p = pinned.get(key);
    if (p) {
      x[i] = p[0];
      y[i] = p[1];
      fixed[i] = 1;
      placed[i] = 1;
    }
  });
  const anyPinned = fixed.some((v) => v);
  // Seed: next to a pinned neighbour when there is one, else a hashed spot in the disc.
  for (let i = 0; i < n; i++) {
    if (placed[i]) {
      continue;
    }
    const h1 = hash01(keys[i]);
    const h2 = hash01(keys[i] + "\u0001");
    const nb = adj[i].find((j) => fixed[j]);
    if (nb !== undefined) {
      x[i] = x[nb] + (h1 - 0.5) * k;
      y[i] = y[nb] + (h2 - 0.5) * k;
    } else {
      const r = SCALE * 0.9 * Math.sqrt(h2);
      x[i] = Math.cos(h1 * Math.PI * 2) * r;
      y[i] = Math.sin(h1 * Math.PI * 2) * r;
    }
    placed[i] = 1;
  }
  const free = [];
  for (let i = 0; i < n; i++) {
    if (!fixed[i]) {
      free.push(i);
    }
  }
  if (!free.length) {
    return keys.map((_, i) => [x[i], y[i]]);
  }
  const iterations = 260;
  const cell = k * 2.5;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const temp = (SCALE / 8) * (1 - it / iterations) + 0.5;
    dx.fill(0);
    dy.fill(0);
    // Repulsion within a cut-off, through a grid so it stays near-linear.
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const gk = Math.floor(x[i] / cell) + "," + Math.floor(y[i] / cell);
      let list = grid.get(gk);
      if (!list) {
        list = [];
        grid.set(gk, list);
      }
      list.push(i);
    }
    for (const i of free) {
      const cx = Math.floor(x[i] / cell);
      const cy = Math.floor(y[i] / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const list = grid.get(gx + "," + gy);
          if (!list) {
            continue;
          }
          for (const j of list) {
            if (j === i) {
              continue;
            }
            let ddx = x[i] - x[j];
            let ddy = y[i] - y[j];
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 < 1e-6) {
              ddx = hash01(keys[i] + keys[j]) - 0.5;
              ddy = hash01(keys[j] + keys[i]) - 0.5;
              d2 = ddx * ddx + ddy * ddy + 1e-6;
            }
            if (d2 > cell * cell) {
              continue;
            }
            const f = (k * k) / d2;
            dx[i] += ddx * f;
            dy[i] += ddy * f;
          }
        }
      }
    }
    // Attraction along facts.
    for (const [a, b] of edges) {
      const ddx = x[a] - x[b];
      const ddy = y[a] - y[b];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 1e-3;
      const f = (d / k) * 0.5;
      dx[a] -= ddx * f;
      dy[a] -= ddy * f;
      dx[b] += ddx * f;
      dy[b] += ddy * f;
    }
    // Gravity, stronger for nodes no fact links, so they ring the graph instead of drifting.
    for (const i of free) {
      const g = adj[i].length ? 0.012 : 0.05;
      dx[i] -= x[i] * g * (k / 10);
      dy[i] -= y[i] * g * (k / 10);
    }
    for (const i of free) {
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (len > 0) {
        const step = Math.min(len, temp);
        x[i] += (dx[i] / len) * step;
        y[i] += (dy[i] / len) * step;
      }
    }
  }
  let s = 1;
  if (!anyPinned) {
    let max = 1e-9;
    for (let i = 0; i < n; i++) {
      max = Math.max(max, Math.abs(x[i]), Math.abs(y[i]));
    }
    s = SCALE / max;
  }
  return keys.map((_, i) => [
    Math.max(-SCALE, Math.min(SCALE, x[i] * s)),
    Math.max(-SCALE, Math.min(SCALE, y[i] * s)),
  ]);
}

/** Previous positions by node key, from an earlier graph.json (or timeline.json, by type and name). */
function previousPositions(file) {
  const out = new Map();
  if (file === undefined || file === null) {
    return out;
  }
  if (typeof file !== "string" || !file) {
    throw new Error("--previous needs the path of last week's graph.json");
  }
  // A wrong path would lay the whole graph out again and move every node on the public page.
  if (!fs.existsSync(file)) {
    throw new Error(`previous layout not found: ${file}`);
  }
  const prev = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(prev.nodes) && prev.nodes.length && typeof prev.nodes[0][0] === "string") {
    for (const r of prev.nodes) {
      if (typeof r[5] === "number" && typeof r[6] === "number") {
        out.set(r[0] + "\u0001" + r[1], [r[5], r[6]]);
      }
    }
  } else if (Array.isArray(prev.nodes) && Array.isArray(prev.types)) {
    for (const r of prev.nodes) {
      out.set("name\u0001" + prev.types[r[2]] + "\u0001" + r[3], [r[0], r[1]]);
    }
  }
  return out;
}

// ── export ──────────────────────────────────────────────────────────────────────

/**
 * Turn an export into graph.json and timeline.json.
 * @param {{vault?: object, episodes?: object[], nodes?: object[], facts?: object[]}} raw
 * @param {{previous?: Map<string, [number, number]>, vault?: object, now?: string}} [opts]
 */
function buildPages(raw, opts = {}) {
  const vault = Object.assign({}, raw.vault || {}, opts.vault || {});
  const group =
    vault.group_id || (vault.slug ? "vault_" + String(vault.slug).replace(/-/g, "_") : "");
  const pinnedIn = opts.previous || new Map();

  // Episodes, de-duplicated by id (the same copy whatever the read order), oldest first.
  const epById = new Map();
  for (const e of raw.episodes || []) {
    const id = String(e.uuid || e.id || "");
    if (id && (!epById.has(id) || later(e, epById.get(id)))) {
      epById.set(id, e);
    }
  }
  const episodes = [...epById.values()].sort(
    (a, b) =>
      (ms(a.created_at) || 0) - (ms(b.created_at) || 0) ||
      String(a.name).localeCompare(String(b.name))
  );
  const epAgent = new Map();
  const epDefault = new Set();
  const factEpisode = new Map();
  for (const e of episodes) {
    const { agent, guessed } = attribute(e);
    for (const id of [e.uuid, e.id].filter(Boolean)) {
      epAgent.set(String(id), agent);
      if (guessed) {
        epDefault.add(String(id));
      }
    }
    for (const f of e.entity_edges || []) {
      if (!factEpisode.has(f)) {
        factEpisode.set(f, e);
      }
    }
  }

  // Nodes, de-duplicated by id and name: the longest summary wins, then a stable comparison,
  // so the copy kept never depends on the order the files were read in.
  const nodeByKey = new Map();
  const nodeRaw = new Map();
  for (const r of raw.nodes || []) {
    const id = stripGroup(r.id || r.uuid, group);
    const key = id + "\u0001" + r.name;
    const prev = nodeRaw.get(key);
    const len = String(r.summary || "").length;
    const plen = prev ? String(prev.summary || "").length : -1;
    if (!prev || len > plen || (len === plen && later(r, prev))) {
      nodeRaw.set(key, r);
      nodeByKey.set(key, Object.assign({}, r, { _id: id, _key: key }));
    }
  }
  const allNodes = [...nodeByKey.values()].sort((a, b) =>
    a._key < b._key ? -1 : a._key > b._key ? 1 : 0
  );

  // Facts, de-duplicated by uuid. A read taken after the fact was superseded beats one from
  // before; then the later invalidation; then a stable comparison.
  const factById = new Map();
  for (const f of raw.facts || []) {
    const id = factId(f);
    const prev = factById.get(id);
    if (id && (!prev || newerFact(f, prev))) {
      factById.set(id, f);
    }
  }
  const facts = [...factById.values()];

  // Time zero: midnight UTC of the earliest thing in the export.
  const times = [
    ...episodes.map((e) => ms(e.created_at)),
    ...facts.map((f) => ms(f.created_at)),
    ...allNodes.map((n) => ms(n.created_at)),
  ].filter((t) => t !== null);
  const now = opts.now || new Date().toISOString();
  const t0 = times.length ? Math.min(...times) : ms(now);
  const start = new Date(Math.floor(t0 / 864e5) * 864e5);
  const minute = (t) => Math.round(((t - start.getTime()) / 60000) * 100) / 100;

  // Agents: every identity that wrote an episode, plus Agent nodes named like one.
  const agentNames = new Set(epAgent.values());
  for (const n of allNodes) {
    if (nodeType(n.labels) === "Agent" && /^vault-[a-z]+$/.test(n.name)) {
      agentNames.add(n.name);
    }
  }
  const agents = [
    ...KNOWN_AGENTS.filter((a) => agentNames.has(a)),
    ...[...agentNames].filter((a) => !KNOWN_AGENTS.includes(a)).sort(),
  ];
  const agentIndex = new Map(agents.map((a, i) => [a, i]));
  const agentNode = new Map();
  for (const n of allNodes) {
    if (nodeType(n.labels) === "Agent" && agentIndex.has(n.name)) {
      agentNode.set(n._key, agentIndex.get(n.name));
    }
  }

  // Endpoint lookup: by id; an id several nodes share is settled by the fact's wording.
  const byId = new Map();
  allNodes.forEach((n, i) => {
    if (!byId.has(n._id)) {
      byId.set(n._id, []);
    }
    byId.get(n._id).push(i);
  });
  const nodeTokens = allNodes.map((n) => tokens(n.name));
  let ambiguous = 0;
  function pick(rawId, factText) {
    const c = byId.get(stripGroup(rawId, group));
    if (!c) {
      return -1;
    }
    if (c.length === 1) {
      return c[0];
    }
    ambiguous++;
    const ft = tokens(factText);
    let best = c[0];
    let bs = -1;
    for (const i of c) {
      let s = 0;
      nodeTokens[i].forEach((t) => {
        if (ft.has(t)) {
          s++;
        }
      });
      const sc = s + (s / Math.max(1, nodeTokens[i].size)) * 0.5;
      if (sc > bs) {
        bs = sc;
        best = i;
      }
    }
    return best;
  }

  const resolved = [];
  let unresolved = 0;
  let byDefault = 0;
  for (const f of facts) {
    const s = pick(f.source_node_id || f.source_node_uuid, f.fact);
    const t = pick(f.target_node_id || f.target_node_uuid, f.fact);
    if (s < 0 || t < 0) {
      unresolved++;
      continue;
    }
    const ep =
      factEpisode.get(factId(f)) ||
      (Array.isArray(f.episodes)
        ? f.episodes.map((id) => epById.get(String(id))).find(Boolean)
        : null);
    const created = ms(f.created_at) ?? (ep ? ms(ep.created_at) : null) ?? t0;
    const agent = ep ? epAgent.get(String(ep.uuid || ep.id)) : null;
    if (!agent || !agentIndex.has(agent) || (ep && epDefault.has(String(ep.uuid || ep.id)))) {
      byDefault++;
    }
    resolved.push({
      f,
      s,
      t,
      created,
      agent: agent && agentIndex.has(agent) ? agent : agents[0] || "vault-librarian",
    });
  }
  if (!agentIndex.size) {
    agents.push("vault-librarian");
    agentIndex.set("vault-librarian", 0);
  }
  resolved.sort((a, b) => a.created - b.created || factId(a.f).localeCompare(factId(b.f)));

  // Degree on current facts, and each node's first appearance.
  const degree = new Array(allNodes.length).fill(0);
  const firstFact = new Array(allNodes.length).fill(Infinity);
  const firstAgent = new Array(allNodes.length).fill(null);
  for (const r of resolved) {
    const inv = !!(r.f.invalid_at || r.f.expired_at);
    for (const i of r.s === r.t ? [r.s] : [r.s, r.t]) {
      if (!inv) {
        degree[i]++;
      }
      if (r.created < firstFact[i]) {
        firstFact[i] = r.created;
        firstAgent[i] = r.agent;
      }
    }
  }
  const nodeAgent = (i) => {
    if (firstAgent[i]) {
      return firstAgent[i];
    }
    const c = ms(allNodes[i].created_at);
    let best = null;
    for (const e of episodes) {
      if (c !== null && (ms(e.created_at) || 0) <= c) {
        best = e;
      }
    }
    return best ? epAgent.get(String(best.uuid || best.id)) : agents[0];
  };

  // Layout over every node, agents included, so graph.json can draw them.
  const edgeSet = new Set();
  const edges = [];
  for (const r of resolved) {
    if (r.s === r.t) {
      continue;
    }
    const a = Math.min(r.s, r.t);
    const b = Math.max(r.s, r.t);
    if (!edgeSet.has(a + "," + b)) {
      edgeSet.add(a + "," + b);
      edges.push([a, b]);
    }
  }
  const pinned = new Map();
  allNodes.forEach((n) => {
    const p =
      pinnedIn.get(n._key) || pinnedIn.get("name\u0001" + nodeType(n.labels) + "\u0001" + n.name);
    if (p) {
      pinned.set(n._key, p);
    }
  });
  const pos = layout(
    allNodes.map((n) => n._key),
    edges,
    pinned
  );
  const xy = (i) => [Math.round(pos[i][0]), Math.round(pos[i][1])];

  // graph.json
  const attrs = (a) => {
    const out = {};
    for (const key of Object.keys(a || {}).sort()) {
      const v = a[key];
      if (key !== "email" && v !== null && v !== undefined && v !== "") {
        out[key] = v;
      }
    }
    return out;
  };
  const graph = {
    schema: SCHEMA,
    vault: { name: vault.name || "", slug: vault.slug || "", group_id: group },
    exported_at: now,
    nodes: allNodes.map((n, i) => [
      n._id,
      n.name,
      nodeType(n.labels),
      String(n.summary || "").slice(0, SUMMARY_CAP),
      attrs(n.attributes),
      ...xy(i),
    ]),
    facts: resolved.map((r) => [
      factId(r.f),
      r.f.name || "RELATES_TO",
      String(r.f.fact || ""),
      allNodes[r.s]._id,
      allNodes[r.t]._id,
      String(r.f.valid_at || "").slice(0, 10),
      r.f.invalid_at || r.f.expired_at ? 1 : 0,
    ]),
    stats: {
      episodes: episodes.length,
      ambiguous,
      unresolved,
      by_default: byDefault,
      pinned: pinned.size,
      more_in_memory: !!raw.has_more,
    },
  };

  // timeline.json: agents leave the node list and become the actors.
  const tlIndex = new Map();
  const tlNodes = [];
  allNodes.forEach((n, i) => {
    if (agentNode.has(n._key)) {
      return;
    }
    tlIndex.set(i, tlNodes.length);
    tlNodes.push(i);
  });
  const typeList = [...new Set(tlNodes.map((i) => nodeType(allNodes[i].labels)))].sort();
  const relList = [...new Set(resolved.map((r) => r.f.name || "RELATES_TO"))].sort();
  const endpoint = (i) =>
    agentNode.has(allNodes[i]._key) ? -1 - agentNode.get(allNodes[i]._key) : tlIndex.get(i);
  const tlFacts = [];
  let agentFacts = 0;
  for (const r of resolved) {
    const s = endpoint(r.s);
    const t = endpoint(r.t);
    if (s < 0 || t < 0) {
      agentFacts++;
    }
    tlFacts.push([
      s,
      t,
      relList.indexOf(r.f.name || "RELATES_TO"),
      minute(r.created),
      agentIndex.get(r.agent),
      r.f.invalid_at || r.f.expired_at ? 1 : 0,
      String(r.f.fact || "").slice(0, FACT_TEXT_CAP),
    ]);
  }
  const nodeRows = tlNodes.map((i) => {
    const appears = Math.min(firstFact[i], ms(allNodes[i].created_at) ?? Infinity);
    const when = Number.isFinite(appears) ? appears : t0;
    return [
      ...xy(i),
      typeList.indexOf(nodeType(allNodes[i].labels)),
      allNodes[i].name,
      minute(when),
      agentIndex.get(nodeAgent(i)) ?? 0,
      degree[i],
    ];
  });
  const dayCounts = new Map();
  for (const row of nodeRows) {
    const d = Math.floor(row[4] / 1440);
    dayCounts.set(d, (dayCounts.get(d) || 0) + 1);
  }
  for (const row of tlFacts) {
    const d = Math.floor(row[3] / 1440);
    dayCounts.set(d, (dayCounts.get(d) || 0) + 1);
  }
  const days = [...dayCounts.keys()]
    .sort((a, b) => a - b)
    .map((d) => ({
      day: d,
      date: new Date(start.getTime() + d * 864e5).toISOString().slice(0, 10),
      events: dayCounts.get(d),
    }));
  const agentAbout = (name) => {
    const n = allNodes.find((x) => agentNode.has(x._key) && x.name === name);
    const line = n && String(n.summary || "").split("\n")[0];
    return (line || AGENT_ABOUT[name] || "An agent of this vault.").slice(0, 160);
  };
  const timeline = {
    schema: SCHEMA,
    vault: { name: vault.name || "", slug: vault.slug || "" },
    start: start.toISOString().replace(".000Z", "Z"),
    agents: agents.map((a) => ({ id: "Agent:" + a, name: a, about: agentAbout(a) })),
    types: typeList,
    rels: relList,
    nodes: nodeRows,
    facts: tlFacts,
    days,
    stats: {
      savedAt: now,
      exportedAt: now,
      episodes: episodes.length,
      nodes: nodeRows.length,
      facts: tlFacts.length,
      invalidated: tlFacts.filter((f) => f[5]).length,
      agentFacts,
      lone: nodeRows.filter((r) => r[6] === 0).length,
      ambiguous,
      unresolved,
    },
  };
  return { graph, timeline };
}

// ── contracts ───────────────────────────────────────────────────────────────────

const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isDate = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}/.test(v);

function checkSource(where, s, problems) {
  if (!s || !isStr(s.url) || !/^https?:\/\//.test(s.url)) {
    problems.push(`${where}: a source needs an http(s) url`);
  }
  if (s && s.retrieved !== undefined && !isDate(s.retrieved)) {
    problems.push(`${where}: retrieved must be a YYYY-MM-DD date`);
  }
}

/** Problems with a page's data file, as plain sentences; empty when it meets the contract. */
function checkData(page, data) {
  const p = [];
  if (!data || typeof data !== "object") {
    return ["not a JSON object"];
  }
  if (PAGES[page] && PAGES[page].data && data.schema !== SCHEMA) {
    p.push(`schema must be ${SCHEMA}`);
  }
  if (page === "brief") {
    if (!data.vault || !isStr(data.vault.name) || !data.vault.name) {
      p.push("vault.name is required");
    }
    if (!isStr(data.week) || !/^\d{4}-W\d{2}$/.test(data.week)) {
      p.push("week must look like 2026-W47");
    }
    if (!isStr(data.headline) || !data.headline) {
      p.push("headline is required");
    }
    if (!Array.isArray(data.changes)) {
      p.push("changes must be an array");
    } else {
      data.changes.forEach((c, i) => {
        if (!isStr(c.finding) || !c.finding) {
          p.push(`changes[${i}]: finding (the Finding's name) is required`);
        }
        if (!isStr(c.title) || !c.title) {
          p.push(`changes[${i}]: title is required`);
        }
        if (!Array.isArray(c.sources) || !c.sources.length) {
          p.push(`changes[${i}]: at least one source`);
        } else {
          c.sources.forEach((s, j) => checkSource(`changes[${i}].sources[${j}]`, s, p));
        }
      });
    }
    for (const [k, v] of [
      ["conflicts", data.conflicts],
      ["sources", data.sources],
    ]) {
      if (v !== undefined && !Array.isArray(v)) {
        p.push(`${k} must be an array`);
      }
    }
    (data.sources || []).forEach((s, j) => checkSource(`sources[${j}]`, s, p));
    (data.conflicts || []).forEach((c, i) => {
      if (!c.a || !c.b) {
        p.push(`conflicts[${i}]: a and b are required`);
      }
    });
  } else if (page === "graph") {
    if (!Array.isArray(data.nodes) || !Array.isArray(data.facts)) {
      return ["nodes and facts must be arrays"];
    }
    data.nodes.forEach((n, i) => {
      if (
        !Array.isArray(n) ||
        n.length !== 7 ||
        !isStr(n[0]) ||
        !isStr(n[1]) ||
        !isStr(n[2]) ||
        !isStr(n[3])
      ) {
        p.push(`nodes[${i}]: expected [id, name, type, summary, attrs, x, y]`);
      } else if (!isNum(n[5]) || !isNum(n[6])) {
        p.push(`nodes[${i}]: x and y must be numbers`);
      }
    });
    const ids = new Set(data.nodes.map((n) => n[0]));
    const factIds = new Set();
    data.facts.forEach((f, i) => {
      if (!Array.isArray(f) || f.length !== 7) {
        p.push(`facts[${i}]: expected [id, rel, fact, source, target, valid_at, invalid]`);
        return;
      }
      if (!isStr(f[0]) || !f[0]) {
        p.push(`facts[${i}]: id is required`);
      } else if (factIds.has(f[0])) {
        // The page draws one fact per id, so a repeated id hides a fact.
        p.push(`facts[${i}]: id ${f[0]} repeats an earlier fact's`);
      }
      factIds.add(f[0]);
      if (!ids.has(f[3]) || !ids.has(f[4])) {
        p.push(`facts[${i}]: endpoint not in nodes`);
      }
    });
  } else if (page === "timelapse") {
    for (const k of ["agents", "types", "rels", "nodes", "facts"]) {
      if (!Array.isArray(data[k])) {
        p.push(`${k} must be an array`);
      }
    }
    if (!isStr(data.start) || ms(data.start) === null) {
      p.push("start must be an ISO date-time");
    }
    if (p.length) {
      return p;
    }
    if (!data.agents.length) {
      p.push("agents must not be empty");
    }
    data.nodes.forEach((n, i) => {
      const ok =
        Array.isArray(n) &&
        n.length === 7 &&
        isNum(n[0]) &&
        isNum(n[1]) &&
        isInt(n[2]) &&
        n[2] >= 0 &&
        n[2] < data.types.length &&
        isStr(n[3]) &&
        isNum(n[4]) &&
        isInt(n[5]) &&
        n[5] >= 0 &&
        n[5] < data.agents.length &&
        isNum(n[6]);
      if (!ok) {
        p.push(`nodes[${i}]: expected [x, y, type, name, minute, agent, weight]`);
      }
    });
    const endOk = (e) => isInt(e) && (e >= 0 ? e < data.nodes.length : -1 - e < data.agents.length);
    data.facts.forEach((f, i) => {
      const ok =
        Array.isArray(f) &&
        f.length === 7 &&
        endOk(f[0]) &&
        endOk(f[1]) &&
        isInt(f[2]) &&
        f[2] >= 0 &&
        f[2] < data.rels.length &&
        isNum(f[3]) &&
        isInt(f[4]) &&
        f[4] >= 0 &&
        f[4] < data.agents.length &&
        (f[5] === 0 || f[5] === 1) &&
        isStr(f[6]);
      if (!ok) {
        p.push(`facts[${i}]: expected [source, target, rel, minute, agent, invalidated, text]`);
      }
    });
    if (!data.nodes.length && !data.facts.length) {
      p.push("nothing to replay: no nodes and no facts");
    }
  } else {
    p.push(`unknown page ${page}`);
  }
  return p.length > 20 ? [...p.slice(0, 20), `… and ${p.length - 20} more problems`] : p;
}

// ── prepare and preview ─────────────────────────────────────────────────────────

function templateHtml(page) {
  return fs.readFileSync(path.join(TEMPLATES, page, "index.html"), "utf8");
}

/** The template with its <title> replaced; the only per-vault edit an index.html gets. */
function withTitle(html, title) {
  const safe = String(title).replace(
    /[<>&]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]
  );
  if (!/<title>[^<]*<\/title>/.test(html)) {
    throw new Error("template has no <title>");
  }
  // A function replacement, so a "$&" or "$1" in a vault's name stays literal.
  return html.replace(/<title>[^<]*<\/title>/, () => `<title>${safe}</title>`);
}

function prepare(page, { title, out, data }) {
  if (!PAGES[page]) {
    throw new Error(`unknown page ${page}; one of ${Object.keys(PAGES).join(", ")}`);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), withTitle(templateHtml(page), title));
  const written = [path.join(out, "index.html")];
  if (PAGES[page].data) {
    if (!data) {
      throw new Error(`${page} needs --data <${PAGES[page].data}>`);
    }
    const parsed = JSON.parse(fs.readFileSync(data, "utf8"));
    const problems = checkData(page, parsed);
    if (problems.length) {
      throw new Error(`${data} does not meet the ${page} contract:\n  ${problems.join("\n  ")}`);
    }
    const target = path.join(out, PAGES[page].data);
    if (path.resolve(data) !== path.resolve(target)) {
      fs.copyFileSync(data, target);
    }
    written.push(target);
  }
  return written;
}

function preview(page, { data, port }) {
  if (!PAGES[page]) {
    throw new Error(`unknown page ${page}`);
  }
  const dir = path.join(TEMPLATES, page);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // The artifact host wraps a published page in a document skeleton; the preview adds the same.
      let head =
        '<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n';
      if (page === "console") {
        head += `<script>\n${fs.readFileSync(path.join(dir, "fixtures", "runtime-mock.js"), "utf8")}\n</script>\n`;
      }
      const html = head + templateHtml(page);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (PAGES[page].data && url.pathname === "/" + PAGES[page].data) {
      const file = data || path.join(dir, "fixtures", PAGES[page].data);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  // Port 0 asks the system for a free one; the line names the port actually bound.
  server.listen(port, "127.0.0.1", () => {
    const bound = server.address().port;
    process.stdout.write(`Previewing ${page} at http://127.0.0.1:${bound}/ (Ctrl+C to stop)\n`);
  });
  return server;
}

// ── command line ────────────────────────────────────────────────────────────────

const HELP = `vault-pages: data files and page copies for a vault's shareable pages

  export  --in <export.json | folder> --out <folder> [--previous <graph.json>]
          [--name <vault name>] [--slug <slug>] [--now <ISO time>]
      Writes graph.json and timeline.json. --previous keeps every node that was in the
      last graph.json exactly where it was, and stops if that file is missing. Exits 1,
      writing nothing, when the export has nothing to draw. --now fixes the export time.
  prepare <brief|graph|timelapse|console> --title "<title>" --out <folder> [--data <file>]
      Copies the template's index.html with that <title>, and the checked data file.
  check   <brief|graph|timelapse> <file>
      Exits 1 and lists what is wrong when the file breaks the page's contract.
  preview <brief|graph|timelapse|console> [--data <file>] [--port 8765]
      Serves the template on 127.0.0.1 with its fixture, or with your data file.
      --port 0 picks a free port and prints it.
`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

function main(argv) {
  const a = args(argv);
  const cmd = a._[0];
  const say = (s) => process.stdout.write(s + "\n");
  if (!cmd || cmd === "help" || a.help) {
    say(HELP);
    return 0;
  }
  if (cmd === "export") {
    if (!a.in || !a.out) {
      throw new Error("export needs --in and --out");
    }
    const raw = readExport(a.in);
    const vault = {};
    if (a.name) {
      vault.name = a.name;
    }
    if (a.slug) {
      vault.slug = a.slug;
    }
    if (a.now && ms(a.now) === null) {
      throw new Error("--now must be an ISO date-time");
    }
    const { graph, timeline } = buildPages(raw, {
      previous: previousPositions(a.previous),
      vault,
      now: a.now,
    });
    // An export that breaks its own contract would only fail later, at prepare.
    const problems = [
      ...checkData("graph", graph).map((x) => "graph.json: " + x),
      ...checkData("timelapse", timeline).map((x) => "timeline.json: " + x),
    ];
    if (problems.length) {
      throw new Error(`the export can't make the pages:\n  ${problems.join("\n  ")}`);
    }
    fs.mkdirSync(a.out, { recursive: true });
    fs.writeFileSync(path.join(a.out, "graph.json"), JSON.stringify(graph));
    fs.writeFileSync(path.join(a.out, "timeline.json"), JSON.stringify(timeline));
    const s = timeline.stats;
    const g = graph.stats;
    say(
      `exported ${s.episodes} episodes: ${s.nodes} nodes, ${s.facts} facts (${s.invalidated} superseded), ` +
        `${timeline.agents.length} agents, ${timeline.days.length} days → ${a.out}` +
        (a.previous ? ` · layout: ${g.pinned} nodes kept in place` : " · layout: computed afresh") +
        (s.unresolved
          ? ` · ${s.unresolved} facts dropped: an endpoint was not in the export`
          : "") +
        (s.ambiguous ? ` · ${s.ambiguous} endpoints settled by name (shared ids)` : "") +
        (g.by_default
          ? ` · ${g.by_default} facts credited to an agent by default (no writer on their episode)`
          : "") +
        (graph.stats.more_in_memory
          ? " · memory holds more episodes than were listed: the pages cover the newest ones"
          : "") +
        (raw.skipped.length
          ? ` · ${raw.skipped.length} files skipped: ${raw.skipped.join(", ")}`
          : "")
    );
    return 0;
  }
  if (cmd === "prepare") {
    const page = a._[1];
    if (!a.title || !a.out) {
      throw new Error("prepare needs --title and --out");
    }
    for (const f of prepare(page, { title: a.title, out: a.out, data: a.data })) {
      say(f);
    }
    return 0;
  }
  if (cmd === "check") {
    const [, page, file] = a._;
    if (!page || !file) {
      throw new Error("check needs a page and a file");
    }
    const problems = checkData(page, JSON.parse(fs.readFileSync(file, "utf8")));
    if (problems.length) {
      say(`${file}: does not meet the ${page} contract`);
      problems.forEach((x) => say("  " + x));
      return 1;
    }
    say(`${file}: ok`);
    return 0;
  }
  if (cmd === "preview") {
    preview(a._[1], { data: a.data, port: Number(a.port) || 8765 });
    return null;
  }
  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}

if (require.main === module) {
  try {
    const code = main(process.argv.slice(2));
    if (code !== null) {
      process.exitCode = code;
    }
  } catch (e) {
    process.stderr.write(`vault-pages: ${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildPages,
  checkData,
  episodeAgent,
  layout,
  previousPositions,
  readExport,
  unwrap,
  withTitle,
  prepare,
  main,
};
