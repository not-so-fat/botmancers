import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Test files use CommonJS:
    "tests/**",
    // Seed scripts use CommonJS:
    "scripts/*.js",
    // Gitignored scratch scripts and logs:
    ".temporal/**",
    // The published MCP bridge package builds and checks itself:
    "packages/**",
  ]),
]);

export default eslintConfig;
