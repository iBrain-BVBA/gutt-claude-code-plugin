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

from lib.scoring import _lines  # noqa: E402


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


class _MeasuredText:
    """Stands in for a variant's text, reporting the length the round measured.

    A suite's `report()` wants the variant map for its keys and for two sizes — the
    character count through `len(text)`, and the non-blank line count, which the table
    reads off `.lines` where the object carries one. Passing today's skill text
    to a re-score quoted today's size beside replies generated from an older one.
    Rounds now record the lengths alongside the hashes; where a round predates that,
    `known` is False and the caller says so rather than printing a current length as
    though it were the measured one.
    """

    def __init__(self, chars, lines, known=True):
        self.chars, self.lines, self.known = chars, lines, known

    def __len__(self):
        return self.chars


def truncated(records):
    """Records whose stored reply was cut short by the retired 6000-char cap.

    A record whose reply is a prefix cannot be re-scored: the verdict was computed
    from the full text, so scoring the prefix silently measures something else.
    Reported rather than skipped, because the count is the caveat on the re-score.
    """
    return [r for r in records if len(r.get("raw") or "") in (3000, 6000)]


def round_identity(stem, meta, guessed):
    """The provenance lines of a re-scored report: which round, which tree, which text.

    The "written before rounds carried identity" line binds to the absence of meta,
    because that absence is what having no identity means. Hung off the length caveat
    instead, it printed on exactly the rounds that *did* carry identity — directly
    under the date, tree and hash lines proving otherwise — and never on the bare-list
    rounds it describes.

    `guessed` names the variants whose length had to be read off today's skill text.
    Its caveat points at the hashes only when there are hashes to point at.
    """
    import run

    if meta:
        out = (f"Round `{stem}` — replies measured {meta['date']}, "
               f"tree {run.describe_tree(meta['git_sha'], meta['git_dirty'])}.\n")
        # The variant hashes carry over, and on a re-scored table they matter more
        # than on a fresh one: where the round's own tree was dirty they are the only
        # thing pinning the text the replies were generated from.
        if meta.get("variant_sha256"):
            pairs = " ".join(f"{k}:{v}" for k, v in meta["variant_sha256"].items())
            out += f"Variant text measured: {pairs}.\n"
    else:
        out = f"Round `{stem}` — written before rounds carried identity.\n"
    # The console line saying so scrolls; the table is what survives, and a length
    # quoted as measured when it was read off today's file is the kind of claim this
    # whole header exists to prevent.
    if guessed:
        out += (
            f"The size shown for {', '.join(guessed)} is the skill text as it "
            "stands now — this round predates recorded variant lengths, so the "
            "length it actually measured is not known."
            + (" The hashes above still identify the text.\n"
               if (meta or {}).get("variant_sha256") else "\n")
        )
    return out


def measured_for(meta, live, variant):
    """The size to print for one variant: what the round recorded, or today's.

    Both numbers or neither. `run.py` records `variant_chars` from one release and
    `variant_lines` from the next, so a round written between the two carries chars and
    not lines — no such file is on disk today, and this is the rule for when one is.
    Taking the measured character count before
    `variant_lines` was written beside it, and taking the measured character count
    while deriving the line count from the text on disk today would put two numbers
    describing two different texts on one row — the confusion this stand-in exists to
    prevent, narrowed to the rounds nobody thought to try. So a round missing either
    falls back to today's text for both and reports `known` false, which the caller
    turns into a line saying the size shown is not what was measured. Discarding a
    recorded character count for those rounds is the cheaper mistake, and unlike the
    alternative it is visible.

    Module level rather than a closure so the offline gate can drive this decision
    directly. A full re-score cannot run where the suite's corpus was never recorded,
    which is everywhere but one machine — so a closure here is a decision nothing
    reachable ever checks.
    """
    stored_chars = (meta or {}).get("variant_chars") or {}
    stored_lines = (meta or {}).get("variant_lines") or {}
    if variant in stored_chars and variant in stored_lines:
        return _MeasuredText(stored_chars[variant], stored_lines[variant])
    today = str(live.get(variant, ""))
    return _MeasuredText(len(today), _lines(today), known=False)


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

    all_cases = {c["id"]: c for c in suite.cases()}
    cut = truncated(records)
    scored, missing, errored = [], 0, 0
    for r in records:
        if r.get("skipped"):
            continue
        # Resolve the case before anything else. An errored record kept for its
        # denominator still reaches `report()`, which indexes cases by id — so a
        # record naming a case the suite has since renamed crashed the re-score
        # rather than being counted as missing.
        case = all_cases.get(r.get("case"))
        if case is None:
            missing += 1
            continue
        # A record with no reply is a job error, not a record to drop. Skipping it
        # shrank the denominator and took its failed verdict with it, so a round
        # whose calls errored re-scored higher than it originally measured.
        if not r.get("raw"):
            errored += 1
            scored.append(r)
            continue
        scored.append({**r, **suite.evaluate(case, r["raw"])})

    # Shape the table from what the round actually holds, not from today's suite.
    # Taking cases and variants from the current definitions gave an older or
    # partial round rows it never measured, and `report()` reads variant_chars from
    # the skill text on disk now — so a re-scored table quoted today's length beside
    # yesterday's replies. Lengths come from the round's own hashes instead.
    measured_cases = {r.get("case") for r in scored}
    case_list = [c for c in suite.cases() if c["id"] in measured_cases]
    # Variant order follows the round, not today's arm list. Filtering today's
    # variants by what the round measured drops any name the suite has since stopped
    # offering — silently, and out of the one table whose job is to describe that
    # round. A measured arm that no longer ships is exactly what a re-score is for.
    # Today's order is kept where it applies so columns stay comparable, and
    # round-only names are appended rather than placed where today's list cannot say.
    measured_variants = {r.get("variant") for r in scored}
    order = [v for v in suite.variants() if v in measured_variants]
    order += [v for v in dict.fromkeys(r.get("variant") for r in scored)
              if v is not None and v not in order]
    live = suite.variants()
    variants = {v: measured_for(meta, live, v) for v in order}

    text, _ = suite.report(scored, case_list, variants)
    print(f"re-scored {len(scored) - errored} of {len(records)} records in {stem}")
    if errored:
        print(f"  {errored} record(s) carry a job error and were kept unscored")
    guessed = [v for v, t in variants.items() if not t.known]
    if guessed:
        print(f"  round predates recorded variant lengths; the size shown for "
              f"{', '.join(guessed)} is today's text, not what was measured")
    if missing:
        print(f"  {missing} record(s) name a case this suite no longer defines")
    if cut:
        print(f"  {len(cut)} record(s) hold a reply at the retired length cap —")
        print("  their stored text is a prefix, so these verdicts are not sound")
    print("\n" + text)

    # An unsound round must not become the stable aggregate. The console lines above
    # scroll; the committed report is what survives, which is the same reasoning that
    # stops a void round writing one. Three conditions make a round unfit to publish:
    # a reply stored as a prefix cannot be re-scored, a record count short of the
    # round's own job count means the run was cut off, a blocked record means a
    # quota or availability wall voided it, and a record naming a case this suite no
    # longer defines means the re-score covered a different case mix than the round
    # measured — which is the one claim the header makes that would then be false.
    if write_report:
        jobs = (meta or {}).get("jobs")
        short = bool(jobs) and len(records) < jobs
        unfit = [
            *([f"{len(cut)} reply(s) stored at a retired length cap"] if cut else []),
            *([f"{len(records)} records for {jobs} jobs — run cut off"]
              if short else []),
            *(["a record is marked blocked — the round hit a wall"]
              if any(r.get("blocked") for r in records) else []),
            *([f"{missing} record(s) name a case this suite no longer defines"]
              if missing else []),
        ]
        if unfit:
            print("\n*** report NOT written — this round cannot support an aggregate:")
            for u in unfit:
                print(f"***   {u}")
            return 1

        model = (meta or {}).get("model")
        slug = "" if model in (None, run.FAST_MODEL) \
            else f"-{model.replace('.', '')}"
        out = HERE / "results" / f"{suite_id}-report{slug}.md"
        head = f"# {suite_id} — re-scored from a stored round\n\n"
        if meta:
            head += (
                f"Judge model: `{meta['model']}`.\n\n"
                f"{len(case_list)} cases, {len(variants)} variants, "
                f"{len(scored)} calls.\n\n"
            )
        head += round_identity(stem, meta, guessed)
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

        # The provenance block must say a round has no identity only when it has
        # none. The line used to hang off the length caveat, so it appeared on every
        # round that recorded its variant lengths and on no round that did not —
        # inverted, and inverted on the artifact whose whole job is provenance.
        NO_ID = "written before rounds carried identity"
        full = {"date": "2026-08-01", "git_sha": "abc1234", "git_dirty": False,
                "variant_sha256": {"V0": "deadbeef"}}
        for label, stem, meta, guessed, want in [
            ("round carrying identity", "r-new", full, [], False),
            ("bare-list round", "r-old", None, ["V0"], True),
            ("meta but no recorded lengths", "r-mid", full, ["V0"], False),
        ]:
            got = round_identity(stem, meta, guessed)
            if (NO_ID in got) != want:
                wrong.append(f"IDENTITY LINE  {label}: "
                             f"{'present' if NO_ID in got else 'absent'}, want "
                             f"{'present' if want else 'absent'}")
            if stem not in got:
                wrong.append(f"IDENTITY LINE  {label}: does not name the round")
        # The caveat may point at hashes only when the header printed some.
        if "hashes above" in round_identity("r", None, ["V0"]):
            wrong.append("IDENTITY LINE  bare round cites hashes it never printed")

        for w in wrong:
            print(w)
        print("rescore reader OK" if not wrong else "rescore reader BROKEN")
        raise SystemExit(1 if wrong else 0)
    if not args:
        raise SystemExit(__doc__)
    raise SystemExit(rescore(args[0], write_report="--write-report" in sys.argv))
