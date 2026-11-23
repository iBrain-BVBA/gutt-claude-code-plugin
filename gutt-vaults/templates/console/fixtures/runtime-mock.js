// A stand-in for the Artifact runtime (window.claude: db and user) with sample Console data,
// for loading the Console template in a headless browser (tests/vaults.test.cjs in the plugin repository, and vault-pages preview).
// ?seed=full loads the sample vault; ?seed=empty, a vault before its first run.
(function () {
  var seedName = (location.search.match(/seed=(\w+)/) || [])[1] || "full";
  var D = function (n) { return new Date(Date.now() - n * 864e5).toISOString(); };
  var store = { findings: {}, steering: {}, briefs: {}, runs: {}, config_changes: {}, calibrations: {}, meta: {} };
  if (seedName === "full") {
    store.meta.vault = { name: "Test Vault", slug: "test-vault", group_id: "vault_test_vault", beats: ["launches", "pricing", "failures"], commit_times: ["12:10", "19:10"], timezone: "Europe/Warsaw" };
    store.meta.config = { config_version: 2, values: { "ladder.stage1_calls": 12 }, class_ceilings: { card_update: 1 }, saved_at: D(3), saved_by: "u1" };
    store.meta.reviewer = { at: D(2), week: "2026-W47", config_version: 2, owner_verdicts: 212, rolling_agreement: 0.91, escalation_rate: 0.84, replay: { k: 17, n: 20 },
      stage_by_class: {
        "finding/launches": { stage: 0, auto_reject: false, auto_approve: false, reject: { n: 9, agree: 9 }, approve: { n: 18, agree: 17 }, rolling_30d: 0.94 },
        "finding/pricing": { stage: 0, auto_reject: false, auto_approve: false, reject: { n: 4, agree: 3 }, approve: { n: 11, agree: 9 }, rolling_30d: 0.82 },
        "finding/failures": { stage: 1, auto_reject: true, auto_approve: false, reject: { n: 14, agree: 13 }, approve: { n: 7, agree: 7 }, rolling_30d: 0.93, last_override: D(10) },
        reverify: { stage: 0, reject: { n: 2, agree: 2 }, approve: { n: 9, agree: 9 }, rolling_30d: 1 },
        card_update: { stage: 1, auto_reject: true, auto_approve: false, reject: { n: 12, agree: 11 }, approve: { n: 35, agree: 35 }, rolling_30d: 0.88 },
        conflict: { stage: 0, approve: { n: 4, agree: 3 }, reject: { n: 1, agree: 1 } } } };
    store.meta.charter = { status: "assembled", assembled_at: D(1), episode_ids: ["a", "b"], sections: [{ applies_to: "scope", title: "Scope", text: "Agents as roles." }, { applies_to: "roles", title: "Roles", text: "Role taxonomy." }] };
    ["2026-W44", "2026-W45", "2026-W46", "2026-W47"].forEach(function (w, i) {
      store.calibrations[w] = { week: w, at: D(30 - i * 7), by_class: { "finding/launches": { agreement: 0.8 + i * 0.04 }, "finding/pricing": { agreement: 0.9 - i * 0.03 }, card_update: { agreement: 0.85 + i * 0.01 } } };
    });
    var src = [{ url: "https://example.com/a", title: "Example source", retrieved: D(1), source_class: "vendor" }];
    function f(id, o) { store.findings[id] = Object.assign({ vault: "test-vault", type: "finding", title: "Finding " + id, claim: "A claim for " + id + ".", why_it_matters: "Because.", beat: "launches", sources: src, significance: 3, features: { domain: "example.com", claim_type: "launch" }, created: D(1) }, o); }
    f("r1-1", { status: "escalated", review: { decision: "escalate", prediction: "reject", confidence: 0.71, precedents: ["p1", "p2"], reason: "vendor page only", stage: 0, class: "finding/launches" } });
    f("r1-2", { status: "escalated", beat: "failures", significance: 2, review: { decision: "escalate", prediction: "approve", confidence: 0.64, precedents: ["p1"], reason: "approve direction not earned", stage: 1, class: "finding/failures" } });
    f("r1-3", { status: "escalated", significance: 5, title: "Significance five finding", review: { decision: "escalate", prediction: "approve", confidence: 0.9, precedents: [], reason: "significance 5 always escalates", stage: 0, class: "finding/launches" } });
    f("r1-4", { type: "conflict", status: "escalated", title: "Pricing conflict", beat: "pricing", conflict: { a_finding: "Vendor X costs $10", b_finding: "Vendor X costs $12", a_claim: "Ten dollars a seat.", b_claim: "Twelve dollars a seat." }, review: { decision: "escalate", prediction: "approve", confidence: 0.6, stage: 0, class: "conflict" } });
    f("r1-5", { type: "conflict", status: "escalated", title: "Parked conflict", left_open: { revisit: "2099-01-01", note: "waiting for Q1 pricing", at: D(1) }, conflict: { a_finding: "A", b_finding: "B", a_claim: "a", b_claim: "b" }, review: { decision: "escalate", prediction: "approve", stage: 0, class: "conflict" } });
    f("r1-6", { status: "auto_approved", audit: true, beat: "failures", review: { decision: "auto_approve", prediction: "approve", confidence: 0.95, precedents: ["p1", "p2", "p3", "p4", "p5"], stage: 1, class: "finding/failures" } });
    f("r1-7", { status: "approved", beat: "pricing", human: { decision: "approved", note: "", at: D(0.5) }, review: { decision: "escalate", prediction: "reject", confidence: 0.71, reason: "vendor pricing page, no independent source", stage: 0, class: "finding/pricing" } });
    f("r1-8", { status: "committed", beat: "pricing", committed_episode: "e1", human: { decision: "rejected", reason: "stale", note: "", at: D(3) }, review: { decision: "escalate", prediction: "approve", confidence: 0.64, stage: 0, class: "finding/pricing" } });
    f("r1-9", { type: "card_update", status: "escalated", title: "Scheduling coordinator card", beat: "", card: { role: "Scheduling coordinator", section: "Evidence", diff: "+ new evidence", first_independent_evidence: true }, review: { decision: "escalate", prediction: "approve", confidence: 0.8, stage: 1, class: "card_update" } });
    store.briefs["brief-2026-W47"] = { vault: "test-vault", week: "2026-W47", status: "draft", at: D(1),
      body_md: "# Test Vault, week 47\n\nTwo findings entered the vault. **Vendor X** cut its price; see [the source](https://example.com/a).\n\n## What changed\n- Finding r1-8 is in\n- A conflict stays open\n\n<img src=x onerror=alert(1)> stays text, and [this link](javascript:alert(1)) is not a link.",
      linkedin_md: "Post " + new Array(40).join("word "),
      page: { schema: 1, vault: { name: "Test Vault", slug: "test-vault" }, week: "2026-W47", headline: "Vendor X cut its price", changes: [{ finding: "Finding r1-8", title: "Finding r1-8", claim: "A claim.", sources: src }], conflicts: [], sources: src } };
    // ?linkedin=long: a post one character over LinkedIn's limit, emoji counted once each, with
    // the draft's other sections around it (they don't count).
    if (/linkedin=long/.test(location.search)) {
      store.briefs["brief-2026-W47"].linkedin_md = "## Title candidates\n1. Long\n\n## Post\n" +
        new Array(3000).join("a") + "\uD83D\uDE80\uD83D\uDE80" + "\n\n## Image prompt\nA rocket.\n\n## Alt text\nA rocket.";
    }
    store.briefs["brief-2026-W46"] = { vault: "test-vault", week: "2026-W46", status: "published", published_at: D(6), committed_episode: "e0", at: D(7),
      body_md: "# Week 46\n\nOne finding.", linkedin_md: "Last week's post" };
    store.steering["steer-20261120-1"] = { vault: "test-vault", text: "Never use vendor webinars", applies_to: "sources", source: "proposed", status: "new", at: D(2) };
    store.runs["curate-2026-11-23"] = { vault: "test-vault", routine: "curate", started: D(0.3), counts: { found: 20, dropped: 3, pending: 0, auto_approved: 2, auto_rejected: 3, escalated: 12, by_beat: { launches: 8, pricing: 6, failures: 6 } }, stage_by_class: {} };
    store.runs["curate-2026-11-22"] = { vault: "test-vault", routine: "curate", started: D(1.3), counts: { found: 18, auto_approved: 1, auto_rejected: 2, escalated: 14 } };
    store.config_changes.v2 = { version: 2, at: D(3), by: "u1", changes: [{ key: "ladder.stage1_calls", old: null, "new": 12 }], committed_episode: null };
  }
  var subs = [];
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function notify() { subs.forEach(function (f) { f(); }); }
  window.__store = store; window.__notify = notify; window.__writes = [];
  var db = {
    collection: function (name) {
      return {
        orderBy: function (field, dir) { return { limit: function (n) { return { onSnapshot: function (cb) {
          var run = function () {
            var docs = Object.keys(store[name]).map(function (id) { var v = store[name][id]; return { id: id, data: function () { return clone(v); }, _v: v }; });
            docs.sort(function (a, b) { return String(b._v[field] || "").localeCompare(String(a._v[field] || "")); });
            cb({ docs: docs.slice(0, n), metadata: { fromCache: false } });
          };
          subs.push(run); setTimeout(run, 5);
        } }; } }; },
        add: function (doc) { var id = "steer-new-" + Object.keys(store[name]).length; store[name][id] = doc; window.__writes.push(["add", name, doc]); setTimeout(notify, 20); return Promise.resolve({ id: id }); }
      };
    },
    doc: function (path) {
      var p = path.split("/"), col = p[0], id = p[1];
      return {
        onSnapshot: function (cb) { var run = function () { var v = store[col][id]; cb({ exists: !!v, data: function () { return clone(v); }, metadata: { fromCache: false } }); }; subs.push(run); setTimeout(run, 5); },
        get: function () { var v = store[col][id]; return Promise.resolve({ exists: !!v, data: function () { return clone(v); } }); },
        set: function (d) { store[col][id] = clone(d); window.__writes.push(["set", path, d]); setTimeout(notify, 20); return Promise.resolve(); },
        update: function (d) { store[col][id] = Object.assign({}, store[col][id], clone(d)); window.__writes.push(["update", path, d]); setTimeout(notify, 20); return Promise.resolve(); },
        "delete": function () { delete store[col][id]; setTimeout(notify, 20); return Promise.resolve(); },
        acquire: function () { return Promise.resolve({ acquired: true }); }
      };
    }
  };
  // ?scenario=<name> clicks through one review flow after load and prints what it saw as
  // a pre#result element, for tests/vaults.test.cjs to read from the dumped DOM.
  var scenario = (location.search.match(/scenario=(\w+)/) || [])[1];
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function card(id) { return document.getElementById("row-" + id); }
  function press(id, label) {
    var b = Array.prototype.filter.call(card(id).querySelectorAll("button"), function (x) { return x.textContent.indexOf(label) === 0; })[0];
    if (!b) throw new Error("no button " + label + " on " + id);
    b.click();
  }
  function last() { return window.__writes[window.__writes.length - 1]; }
  var SCENARIOS = {
    reject: function () {
      press("r1-1", "Reject"); return wait(50).then(function () {
        press("r1-1", "Stale"); return wait(100);
      }).then(function () {
        return { write: last(), card: card("r1-1").className, text: card("r1-1").textContent, toast: document.getElementById("toast").textContent };
      });
    },
    undo: function () {
      press("r1-2", "Approve"); return wait(100).then(function () {
        document.querySelector("#toast button").click(); return wait(100);
      }).then(function () { return { status: store.findings["r1-2"].status, human: store.findings["r1-2"].human || null }; });
    },
    undo_after_commit: function () {
      press("r1-2", "Approve"); return wait(100).then(function () {
        store.findings["r1-2"] = Object.assign({}, store.findings["r1-2"], { status: "committed", committed_episode: "e9" });
        document.querySelector("#toast button").click(); return wait(150);
      }).then(function () { return { status: store.findings["r1-2"].status, toast: document.getElementById("toast").textContent }; });
    },
    leave_open: function () {
      press("r1-4", "Leave open"); return wait(50).then(function () {
        press("r1-4", "Keep open"); return wait(100);
      }).then(function () { return { status: store.findings["r1-4"].status, left_open: store.findings["r1-4"].left_open, human: store.findings["r1-4"].human || null }; });
    },
    in_place: function () {
      press("r1-1", "Add a note"); var ta;
      return wait(50).then(function () {
        ta = document.getElementById("note-r1-1"); ta.focus(); ta.value = "half typed";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        store.findings["r9-1"] = Object.assign({}, store.findings["r1-2"], { title: "Row from a routine" });
        notify(); return wait(200);
      }).then(function () {
        var now = document.getElementById("note-r1-1");
        return { same: now === ta, value: now.value, focused: document.activeElement === ta, added: !!card("r9-1") };
      });
    }
  };
  if (scenario) window.addEventListener("load", function () {
    wait(300).then(SCENARIOS[scenario]).then(null, function (e) { return { error: String(e) }; }).then(function (res) {
      var pre = document.createElement("pre"); pre.id = "result"; pre.textContent = JSON.stringify(res); document.body.appendChild(pre);
    });
  });
  window.claude = { use: function (cap) {
    if (cap === "db") return Promise.resolve(db);
    if (cap === "user") return Promise.resolve({ can: function () { return Promise.resolve(true); }, canEdit: function () { return Promise.resolve(true); }, id: function () { return Promise.resolve("u1"); }, profiles: function () { return Promise.resolve({ u1: { name: "Test Owner" } }); } });
    return Promise.resolve(null);
  } };
})();
