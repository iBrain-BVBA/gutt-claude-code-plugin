"use strict";
// lint-staged config.
//
// It moved out of package.json in GP-855 to filter symlinks off the file list —
// prettier errors on a symlink passed to it explicitly ("is a symbolic link"), so
// staging one meant committing with --no-verify. GP-933 removed every symlink from
// the repo and CI keeps them out (tests/check-no-symlinks.cjs), so the filter is gone
// and this is a plain config again.
const quote = (files) => files.map((f) => `"${f}"`).join(" ");

module.exports = {
  "*.{js,cjs,mjs,ts,jsx,tsx}": (files) => [
    `eslint --fix ${quote(files)}`,
    `prettier --write ${quote(files)}`,
  ],
  "*.{json,md,yml,yaml}": (files) => [`prettier --write ${quote(files)}`],
};
