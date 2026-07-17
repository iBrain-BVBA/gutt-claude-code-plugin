"use strict";
// lint-staged config (moved out of package.json so it can filter symlinks).
//
// hooks/lib/*.cjs are symlinks into shared/ (GP-853). Prettier errors when a
// symlink is passed to it explicitly ("is a symbolic link"), which is why staged
// symlinks previously couldn't be committed without --no-verify. The canonical
// real files live in shared/ and are linted/formatted directly, so skipping the
// symlinks here loses no coverage. (GP-855)
const fs = require("fs");

const quote = (files) => files.map((f) => `"${f}"`).join(" ");
const realFiles = (files) => files.filter((f) => !fs.lstatSync(f).isSymbolicLink());

module.exports = {
  "*.{js,cjs,mjs,ts,jsx,tsx}": (files) => {
    const real = realFiles(files);
    if (real.length === 0) {
      return [];
    }
    return [`eslint --fix ${quote(real)}`, `prettier --write ${quote(real)}`];
  },
  "*.{json,md,yml,yaml}": (files) => {
    const real = realFiles(files);
    if (real.length === 0) {
      return [];
    }
    return [`prettier --write ${quote(real)}`];
  },
};
