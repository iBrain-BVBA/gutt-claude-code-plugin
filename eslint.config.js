import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "warn",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // gutt-vaults/templates/ holds browser pages published as artifacts and the stand-in
    // runtime their tests load; they are written for the page, not for Node, like the
    // inline scripts in the same templates.
    ignores: ["node_modules/", "dist/", "coverage/", ".claude/", "gutt-vaults/templates/"],
  },
];
