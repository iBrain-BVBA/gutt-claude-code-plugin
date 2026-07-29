#!/usr/bin/env python3
"""Tables for a finished run: verdict accuracy, error direction, per-case detail."""
import collections


def _lines(text):
    return len([l for l in text.split("\n") if l.strip()])


def accuracy_table(results, cases, variants, order=None, extra_cols=None):
    """Accuracy overall and on confidently-labelled cases, plus error direction.

    Returned as text so a caller can print it and also write it to a report.
    """
    order = order or list(variants)
    by = collections.defaultdict(list)
    for r in results:
        by[r["variant"]].append(r)
    index = {c["id"]: c for c in cases}

    head = (f"{'variant':12} {'lines':>5} {'chars':>6} {'all':>8} {'confident':>10} "
            f"{'missed fire':>12} {'false fire':>11} {'livelock':>9} {'errors':>7}")
    rows = [head, "-" * len(head)]
    summary = {}
    for v in order:
        rs = by.get(v) or []
        if not rs:
            rows.append(f"{v:12} {'—  no results':>40}")
            continue
        conf = [r for r in rs if index[r["case"]]["confident"]]
        fires = [r for r in rs if index[r["case"]]["want_ok"] is False]
        quiets = [r for r in rs if index[r["case"]]["want_ok"] is True]
        live = [r for r in rs if index[r["case"]].get("stop_hook_active")]
        missed = sum(1 for r in fires if r.get("got_ok") is not False)
        false_fire = sum(1 for r in quiets if r.get("got_ok") is False)
        broke = sum(1 for r in live if r.get("got_ok") is not True)
        errs = sum(1 for r in rs if r.get("error") or not r.get("parsed", True))
        acc = sum(bool(r.get("correct")) for r in rs) / len(rs)
        acc_c = sum(bool(r.get("correct")) for r in conf) / len(conf) if conf else 0
        summary[v] = {"acc": acc, "acc_confident": acc_c, "missed": missed,
                      "fires": len(fires), "false_fire": false_fire,
                      "quiets": len(quiets), "livelock": broke, "errors": errs,
                      "lines": _lines(variants[v]), "chars": len(variants[v])}
        rows.append(
            f"{v:12} {_lines(variants[v]):>5} {len(variants[v]):>6} {acc:>7.0%} {acc_c:>10.0%} "
            f"{missed:>7}/{len(fires):<4} {false_fire:>6}/{len(quiets):<4} "
            f"{broke:>4}/{len(live):<4} {errs:>7}"
        )
    return "\n".join(rows), summary


def per_case_table(results, cases, variants, order=None):
    order = order or list(variants)
    by = collections.defaultdict(list)
    for r in results:
        by[(r["variant"], r["case"])].append(r)
    rows = [f"{'case':>11} {'want':>6}" + "".join(f"{v:>11}" for v in order)]
    rows.append("-" * len(rows[0]))
    for c in cases:
        cells = ""
        for v in order:
            rs = by.get((v, c["id"])) or []
            cells += (f"{sum(bool(r.get('correct')) for r in rs)}/{len(rs)}" if rs else "—").rjust(11)
        want = "FIRE" if not c["want_ok"] else "quiet"
        rows.append(f"{c['id']:>11} {want:>6}{'~' if not c['confident'] else ' '}{cells}")
    return "\n".join(rows)


def shape_table(results, cases, variants, order=None):
    """How well the fired reason matched the shape the prompt asked for."""
    order = order or list(variants)
    index = {c["id"]: c for c in cases}
    by = collections.defaultdict(list)
    for r in results:
        if r.get("shape") and index[r["case"]]["want_ok"] is False:
            by[r["variant"]].append(r["shape"])
    head = (f"{'variant':12} {'n':>3} {'chars':>7} {'names skill':>12} {'all typed':>10} "
            f"{'>10 words':>10} {'gated type':>11} {'json echo':>10}")
    rows = [head, "-" * len(head)]
    for v in order:
        s = by.get(v) or []
        if not s:
            rows.append(f"{v:12} {0:>3}   never fired on a case that should")
            continue
        n = len(s)
        rows.append(
            f"{v:12} {n:>3} {sum(x['chars'] for x in s)//n:>7} "
            f"{sum(x['names_skill'] for x in s)/n:>11.0%} {sum(x['all_typed'] for x in s)/n:>9.0%} "
            f"{sum(1 for x in s if x['over_10w'])/n:>9.0%} {sum(x['gated_type'] for x in s)/n:>10.0%} "
            f"{sum(x['json_echo'] for x in s)/n:>9.0%}"
        )
    return "\n".join(rows)
