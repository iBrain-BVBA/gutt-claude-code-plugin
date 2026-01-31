export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", // New feature
        "fix", // Bug fix
        "docs", // Documentation
        "style", // Formatting, missing semicolons, etc.
        "refactor", // Code change that neither fixes a bug nor adds a feature
        "perf", // Performance improvement
        "test", // Adding tests
        "chore", // Maintenance
        "ci", // CI/CD changes
        "build", // Build system changes
        "revert", // Revert a commit
      ],
    ],
    "subject-case": [2, "always", "lower-case"],
    "header-max-length": [2, "always", 100],
  },
};
