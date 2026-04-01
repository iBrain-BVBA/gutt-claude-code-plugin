const assert = require("assert");
const { classifyBashCommand, ALWAYS_BLOCKED } = require("../hooks/pre-tool-delegation-guard.cjs");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  \u2713", name);
    passed++;
  } catch (err) {
    console.log("  \u2717", name);
    console.log("    ", err.message);
    failed++;
  }
}

console.log("Delegation Guard Unit Tests\n");

console.log("WORKFLOW_PREFIXES (should ALLOW):");
test("git add . → allow", () => {
  assert.strictEqual(classifyBashCommand("git add .").verdict, "allow");
});
test("git add src/file.js → allow", () => {
  assert.strictEqual(classifyBashCommand("git add src/file.js").verdict, "allow");
});
test("git commit -m 'fix' → allow", () => {
  assert.strictEqual(classifyBashCommand("git commit -m 'fix'").verdict, "allow");
});
test("git push origin main → allow", () => {
  assert.strictEqual(classifyBashCommand("git push origin main").verdict, "allow");
});
test("git push → allow", () => {
  assert.strictEqual(classifyBashCommand("git push").verdict, "allow");
});
test("gh pr create --title test → allow", () => {
  assert.strictEqual(classifyBashCommand("gh pr create --title test").verdict, "allow");
});
test("gh pr merge 123 → allow", () => {
  assert.strictEqual(classifyBashCommand("gh pr merge 123").verdict, "allow");
});
test("gh issue create --title bug → allow", () => {
  assert.strictEqual(classifyBashCommand("gh issue create --title bug").verdict, "allow");
});
test("gh release create v1.0 → allow", () => {
  assert.strictEqual(classifyBashCommand("gh release create v1.0").verdict, "allow");
});
test("git fetch origin → allow", () => {
  assert.strictEqual(classifyBashCommand("git fetch origin").verdict, "allow");
});
test("git pull → allow", () => {
  assert.strictEqual(classifyBashCommand("git pull").verdict, "allow");
});
test("git merge feature-branch → allow", () => {
  assert.strictEqual(classifyBashCommand("git merge feature-branch").verdict, "allow");
});

console.log("\nWRITE_PREFIXES (should BLOCK):");
test("git reset --hard HEAD → block", () => {
  assert.strictEqual(classifyBashCommand("git reset --hard HEAD").verdict, "block");
});
test("git checkout -- file.js → block", () => {
  assert.strictEqual(classifyBashCommand("git checkout -- file.js").verdict, "block");
});
test("git restore file.js → block", () => {
  assert.strictEqual(classifyBashCommand("git restore file.js").verdict, "block");
});
test("git clean -fd → block", () => {
  assert.strictEqual(classifyBashCommand("git clean -fd").verdict, "block");
});
test("git rebase main → block", () => {
  assert.strictEqual(classifyBashCommand("git rebase main").verdict, "block");
});
test("git cherry-pick abc123 → block", () => {
  assert.strictEqual(classifyBashCommand("git cherry-pick abc123").verdict, "block");
});
test("rm -rf node_modules → block", () => {
  assert.strictEqual(classifyBashCommand("rm -rf node_modules").verdict, "block");
});
test("npm install express → block", () => {
  assert.strictEqual(classifyBashCommand("npm install express").verdict, "block");
});
test("sed -i 's/foo/bar/' file.js → block", () => {
  assert.strictEqual(classifyBashCommand("sed -i 's/foo/bar/' file.js").verdict, "block");
});

console.log("\nREADONLY_PREFIXES (should ALLOW):");
test("git status → allow", () => {
  assert.strictEqual(classifyBashCommand("git status").verdict, "allow");
});
test("git log --oneline → allow", () => {
  assert.strictEqual(classifyBashCommand("git log --oneline").verdict, "allow");
});
test("git diff → allow", () => {
  assert.strictEqual(classifyBashCommand("git diff").verdict, "allow");
});
test("ls -la → allow", () => {
  assert.strictEqual(classifyBashCommand("ls -la").verdict, "allow");
});

console.log("\nWRITE_EXCEPTIONS (should ALLOW):");
test("npm run lint → allow", () => {
  assert.strictEqual(classifyBashCommand("npm run lint").verdict, "allow");
});
test("npm run test → allow", () => {
  assert.strictEqual(classifyBashCommand("npm run test").verdict, "allow");
});
test("npx tsc --noEmit → allow", () => {
  assert.strictEqual(classifyBashCommand("npx tsc --noEmit").verdict, "allow");
});

console.log("\nEdge cases:");
test("empty string → warn", () => {
  assert.strictEqual(classifyBashCommand("").verdict, "warn");
});
test("FOO=bar git add . → allow (env var prefix stripped)", () => {
  assert.strictEqual(classifyBashCommand("FOO=bar git add .").verdict, "allow");
});
test("  git add .   → allow (whitespace trimmed)", () => {
  assert.strictEqual(classifyBashCommand("  git add .  ").verdict, "allow");
});

console.log("\nALWAYS_BLOCKED set:");
test("ALWAYS_BLOCKED contains Edit", () => {
  assert.strictEqual(ALWAYS_BLOCKED.has("Edit"), true);
});
test("ALWAYS_BLOCKED contains Write", () => {
  assert.strictEqual(ALWAYS_BLOCKED.has("Write"), true);
});
test("ALWAYS_BLOCKED contains NotebookEdit", () => {
  assert.strictEqual(ALWAYS_BLOCKED.has("NotebookEdit"), true);
});
// Note: plan file path exception cannot be unit tested here — it requires
// the full stdin handler with tool_input context, not just classifyBashCommand.

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
