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
    ignores: ["node_modules/", "dist/", "coverage/", ".claude/"],
  },
];
