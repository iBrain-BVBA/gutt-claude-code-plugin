#!/usr/bin/env python3
"""Re-score a stored round with the current checkers, without spending anything.

    python3 -m lib.rescore results/<suite>-<n>t-<variants>.json
    python3 -m lib.rescore results/<...>.json --write-report

This is the reader the round files never had. Replies are stored in full so that a
checker change can be re-applied to rounds already measured, which is the cheap half
of every checker fix: the expensive half is the `claude -p` calls, and those do not
need repeating. Before this existed the re-score was an ad-hoc script each time, and
each one had to rediscover that rounds come in two shapes.

`--write-report` regenerates the committed table from the stored replies and says in
the header that it was re-scored rather than re-run. That distinction matters: a
re-scored table is the same sample under a new instrument, so it may be compared
against the round it replaces, while a fresh run is a new sample and may not.
"""
import importlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))


def load_round(path):
    """Return `(meta, records)` for a round file of either shape.

    Rounds written before round identity existed are a bare list; rounds written
    since are `{"meta": …, "records": […]}`. Both are on disk and neither is going
    away, so every reader has to accept both — which is the argument for one reader.
    """
    data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    if isinstance(data, list):
        return None, data
    return data.get("meta"), data.get("records", [])


def truncated(records):
    """Records whose stored reply was cut short by the retired 6000-char cap.

    A record whose reply is a prefix cannot be re-scored: the verdict was computed
    from the full text, so scoring the prefix silently measures something else.
    Reported rather than skipped, because the count is the caveat on the re-score.
    """
    return [r for r in records if len(r.get("raw") or "") in (3000, 6000)]


def rescore(path, write_report=False):
    meta, records = load_round(path)
    stem = pathlib.Path(path).stem
    suite_id = (meta or {}).get("suite") or stem.split("-3t-")[0].rsplit("-", 1)[0]
    import run  # the suite registry lives there; importing it avoids a second copy

    if suite_id not in run.SUITES:
        # Fall back to the longest registered id the filename starts with: a raw
        # file's stem is "<suite>-<trials>t-<variants>", and suite ids contain
        # hyphens too, so splitting on them cannot recover the boundary.
        cands = [s for s in run.SUITES if stem.startswith(s + "-")]
        if not cands:
            raise SystemExit(f"cannot tell which suite {stem} belongs to; try --list")
        suite_id = max(cands, key=len)
    suite = importlib.import_module(run.SUITES[suite_id])

    cases = {c["id"]: c for c in suite.cases()}
    variants = suite.variants()
    cut = truncated(records)
    scored, missing = [], 0
    for r in records:
        if r.get("skipped") or not r.get("raw"):
            continue
        case = cases.get(r.get("case"))
        if case is None:
            missing += 1
            continue
        scored.append({**r, **suite.evaluate(case, r["raw"])})

    text, _ = suite.report(scored, list(cases.values()), variants)
    print(f"re-scored {len(scored)} of {len(records)} records in {stem}")
    if missing:
        print(f"  {missing} record(s) name a case this suite no longer defines")
    if cut:
        print(f"  {len(cut)} record(s) hold a reply at the retired length cap —")
        print("  their stored text is a prefix, so these verdicts are not sound")
    print("\n" + text)

    if write_report:
        model = (meta or {}).get("model")
        slug = "" if model in (None, run.FAST_MODEL) \
            else f"-{model.replace('.', '')}"
        out = HERE / "results" / f"{suite_id}-report{slug}.md"
        head = f"# {suite_id} — re-scored from a stored round\n\n"
        if meta:
            head += (
                f"Judge model: `{meta['model']}`.\n\n"
                f"{meta.get('cases', len(cases))} cases, {len(variants)} variants, "
                f"{len(scored)} calls.\n\n"
                f"Round `{stem}` — replies measured {meta['date']}, "
                f"tree {run.describe_tree(meta['git_sha'], meta['git_dirty'])}.\n"
            )
        else:
            head += f"Round `{stem}` — written before rounds carried identity.\n"
        # Two trees, and the second is the one a reader needs. The round's own tree
        # produced the replies; this one holds the checkers that turned them into
        # numbers. They coincide only when a round is scored by the code that ran it,
        # and the whole reason to re-score is that they do not.
        scored_at = run.git_state("scored")
        head += (
            f"Scored by the checkers in tree "
            f"{run.describe_tree(scored_at['scored_sha'], scored_at['scored_dirty'])}"
            " — re-scored offline, not re-run: same replies, new instrument."
            " Comparable with the table it replaces; not comparable with a fresh"
            " round, which is a new sample.\n\n"
        )
        out.write_text(head + f"```\n{text}\n```\n", encoding="utf-8")
        print(f"\n-> {out}")
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--self-check" in sys.argv:
        # Both round shapes must come back identical through one reader, and a
        # reply sitting exactly at a retired cap must be reported rather than
        # scored silently.
        import tempfile

        wrong = []
        recs = [{"case": "a", "raw": "x" * 10}, {"case": "b", "raw": "y" * 6000}]
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            (d / "old.json").write_text(json.dumps(recs))
            (d / "new.json").write_text(json.dumps({"meta": {"suite": "s"},
                                                    "records": recs}))
            m_old, r_old = load_round(d / "old.json")
            m_new, r_new = load_round(d / "new.json")
            if (m_old, r_old) != (None, recs):
                wrong.append(f"BARE LIST  got {(m_old, r_old)!r}")
            if (m_new, r_new) != ({"suite": "s"}, recs):
                wrong.append(f"META SHAPE  got {(m_new, r_new)!r}")
            if r_old != r_new:
                wrong.append("SHAPES DISAGREE  one reader returned two record lists")
        if len(truncated(recs)) != 1:
            wrong.append(f"CAP DETECTION  found {len(truncated(recs))}, want 1")
        for w in wrong:
            print(w)
        print("rescore reader OK" if not wrong else "rescore reader BROKEN")
        raise SystemExit(1 if wrong else 0)
    if not args:
        raise SystemExit(__doc__)
    raise SystemExit(rescore(args[0], write_report="--write-report" in sys.argv))
