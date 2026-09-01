// Runs the same rule set the community directory's review runs, so a finding
// shows up here rather than in a rejected submission.
//
//   npm run lint
//
// Scoped to what the review actually reads: the shipped source, the manifest,
// and the licence. `tests/` is deliberately out of scope — it is full of jsdom
// stand-ins that trip DOM-idiom rules (`createDiv` over `createElement`) while
// never running inside Obsidian, so linting it would bury the findings that
// matter under hundreds that do not.
import tsparser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores([
    "main.js",
    "node_modules/**",
    "docs/**",
    "tests/**",
    "vitest.config.mts",
    "esbuild.config.mjs",
  ]),
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
]);
