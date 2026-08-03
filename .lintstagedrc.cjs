"use strict";
// lint-staged config.
//
// It moved out of package.json in GP-855 to filter symlinks off the file list —
// prettier errors on a symlink passed to it explicitly ("is a symbolic link"), so
// staging one meant committing with --no-verify. GP-933 removed every symlink from
// the repo and CI keeps them out (tests/check-no-symlinks.cjs), so the filter is gone
// and this is a plain config again. The array form is what lint-staged appends staged
// paths to directly: it spawns without a shell, so quoting them by hand was only ever
// reproducing that, and doing it wrong on a path containing a space.
module.exports = {
  "*.{js,cjs,mjs,ts,jsx,tsx}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml}": ["prettier --write"],
};
