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
 *
 * ## The one handover it does remove
 *
 * A host that holds the session credential itself hands its direct child a descriptor to
 * read the token from, plus flags saying not to log in. Both are true for that child and
 * false one hop further down: `spawnSync` does not pass fd 3 and up, so the judge inherits
 * a variable naming a descriptor absent from its own process, is told not to authenticate,
 * and exits without doing any work — every turn, with nothing in the conversation to show
 * it. `childEnv` therefore removes that handover, and only it, and only where the
 * descriptor variable is there to identify it. See `HOST_AUTH_HANDOFF`.
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
 * The variable whose presence means the credential was handed over in the form a
 * grandchild cannot reach. The condition is deliberately this and not a test for which
 * product is hosting us: `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is also set where the
 * handover *does* survive a spawn and capture works, so an unconditional strip would
 * disturb a healthy surface — and a test for the surface encodes today's topology and
 * fails silently when it changes.
 */
const HANDOFF_DESCRIPTOR = "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR";

/**
 * The handover, removed as a unit because it is one instruction rather than four
 * settings: leave any of the first four behind and the child still waits for a token that
 * is not coming.
 *
 * `CLAUDE_CONFIG_DIR` is in the list for a different reason, and it is the one that does
 * the work: it points at a per-session configuration root holding identity but no token,
 * so a child that keeps it looks for credentials there and stops. Removing the other four
 * without it changes nothing at all.
 *
 * The consequence is worth stating rather than discovering: with it gone the child reads
 * the host's own configuration directory, which is both why this works and why it only
 * helps someone who has a working login there.
 */
const HOST_AUTH_HANDOFF = [
  HANDOFF_DESCRIPTOR,
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CONFIG_DIR",
];

/**
 * The environment for a `claude -p` child: everything this process has, plus the
 * guard, minus the handover above where it is present. Otherwise inherited rather than
 * filtered — see the note above on why the harness's scrubbing does not belong in
 * production.
 *
 * @param {Object} [extra] - variables to add or override
 * @param {Object} [env] - base environment, defaults to this process's
 * @returns {Object}
 */
function childEnv(extra = {}, env = process.env) {
  const child = { ...env, ...extra, [NESTED_ENV_VAR]: "1" };
  // This does not contradict the section above. That rule exists to keep the child *able*
  // to authenticate, and none of these are credentials: they are a pointer at a descriptor
  // that does not exist in this process, and flags telling the child not to log in.
  // Removing them is what lets it fall back to its own login instead of waiting for a
  // token that will never arrive.
  //
  // Truthy rather than a presence check: a variable that is set but empty names no
  // descriptor, and acting on it would strip a configuration root on the strength of
  // noise.
  if (child[HANDOFF_DESCRIPTOR]) {
    for (const key of HOST_AUTH_HANDOFF) {
      delete child[key];
    }
  }
  return child;
}

module.exports = { NESTED_ENV_VAR, isNestedRun, childEnv };
