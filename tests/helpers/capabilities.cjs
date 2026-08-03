#!/usr/bin/env node
/**
 * Filesystem capability probes, for tests whose *premise* is an operation the host
 * platform may refuse.
 *
 * These exist to keep one distinction visible: a test that cannot construct its
 * precondition has not found a bug, and reporting it as a failure buries the real
 * ones. Windows is where this bites — creating a symlink needs Developer Mode or an
 * elevated shell, and `chmod` on a directory does nothing at all — so the whole
 * suite reported red on Windows for reasons that said nothing about the code.
 *
 * Probed at runtime rather than switched on `process.platform`, because both
 * capabilities are configuration-dependent: a Windows host with Developer Mode on
 * *can* make symlinks, and should run those tests rather than skip them.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** @type {boolean|null} */
let symlinkSupport = null;

/**
 * Whether this host lets an unprivileged process create a symlink.
 *
 * Probed once and cached — the answer cannot change mid-run, and the probe touches
 * the filesystem.
 *
 * @returns {boolean}
 */
function canSymlink() {
  if (symlinkSupport !== null) {
    return symlinkSupport;
  }
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-symlink-probe-"));
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    symlinkSupport = true;
  } catch {
    symlinkSupport = false;
  } finally {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return symlinkSupport;
}

/**
 * Whether making a directory read-only via `chmod` actually blocks writes into it.
 *
 * False on Windows: Node maps `chmod` onto the read-only *attribute*, which applies
 * to files and is ignored for directories. A test that chmods a directory to 0o500
 * and expects the next write to fail therefore observes a successful write — the
 * assertion fails while the code under test is behaving correctly.
 *
 * @returns {boolean}
 */
function canRestrictDirectoryWrites() {
  return process.platform !== "win32";
}

module.exports = { canSymlink, canRestrictDirectoryWrites };
