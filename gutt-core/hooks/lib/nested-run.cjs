/**
 * Nested-run guard (GP-866).
 *
 * The Stop capture judge invokes the model by spawning `claude -p`. That child
 * cannot use `--bare` — bare mode never reads OAuth or the keychain and needs an
 * API key, which a subscription install does not have (see
 * `docs/headless-cli-reference.md` §2). So the child starts **non-bare**, which
 * means it loads `~/.claude`, every installed plugin, and therefore this plugin's
 * own hooks — including the Stop hook that spawned it.
 *
 * Left alone, that is unbounded recursion, not an edge case: hook spawns child,
 * child's hook spawns grandchild. Nothing on the platform prevents it for us.
 * `--plugin-dir` does not inherit into the child, which is why a first attempt to
 * test this was vacuous — under `--plugin-dir` the child has no copy of the hook to
 * re-enter, so the guard never fires and looks like it works. Only an *installed*
 * plugin reproduces the real shape.
 *
 * The guard is one env var, set on the child and checked at the top of every
 * command hook before any IO. It has to cover more than Stop: a non-bare child also
 * fires SessionStart and UserPromptSubmit, which would write session records into
 * `${CLAUDE_PLUGIN_DATA}` and attribute a judge subprocess's lifecycle to the user's
 * session; and on SIGTERM the child runs SessionEnd hooks on the way out (exit 143).
 *
 * ## Why this does not scrub the billable environment
 *
 * R36 requires headless runs to stay on the subscription, and
 * `tests/e2e/lib/claude-run.cjs` enforces it by deleting `ANTHROPIC_API_KEY` and
 * friends before launching. That is a **test-harness** requirement — it stops the
 * suite billing someone's API key — and it must not be copied here. In production the
 * child inherits the user's own credentials on purpose: someone who authenticates
 * *with* `ANTHROPIC_API_KEY` and no OAuth would find a scrubbed child unable to
 * authenticate at all, and per `docs/hook-platform-capabilities.md` §5 an
 * unauthenticated judge fails silently — no verdict, no user-visible sign. Paying for
 * the judge the same way you pay for the session is correct; breaking the judge to
 * avoid the charge is not.
 */

/**
 * Set on the child, checked by every hook. Deliberately prefixed rather than
 * borrowing `CLAUDE_CODE_*`: the platform owns that namespace and could give a
 * same-named variable its own meaning.
 */
const NESTED_ENV_VAR = "GUTT_NESTED_RUN";

/**
 * @param {Object} [env] - defaults to this process's environment
 * @returns {boolean} true when a hook of ours spawned the run we are inside
 */
function isNestedRun(env = process.env) {
  return env[NESTED_ENV_VAR] === "1";
}

/**
 * The environment for a `claude -p` child: everything this process has, plus the
 * guard. Inherited rather than filtered — see the note above on why the harness's
 * scrubbing does not belong in production.
 *
 * @param {Object} [extra] - variables to add or override
 * @param {Object} [env] - base environment, defaults to this process's
 * @returns {Object}
 */
function childEnv(extra = {}, env = process.env) {
  return { ...env, ...extra, [NESTED_ENV_VAR]: "1" };
}

module.exports = { NESTED_ENV_VAR, isNestedRun, childEnv };
