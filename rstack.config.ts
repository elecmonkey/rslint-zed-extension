import { define } from "rstack";

define.lib({
  source: {
    entry: {
      "rslint-lsp": "./src/launcher.ts",
    },
  },
});

define.test({
  include: ["./tests/**/*.test.ts"],
  testTimeout: 20_000,
});

define.lint(({ js, rstestPlugin, ts }) => [
  { ignores: ["rstack-editor/**", "dist/**"] },
  js.configs.recommended,
  ts.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
      },
    },
  },
  {
    files: ["tests/**/*.test.ts"],
    ...rstestPlugin.configs.recommended,
    rules: {
      ...rstestPlugin.configs.recommended.rules,
      "rstest/expect-expect": [
        "warn",
        { assertFunctionNames: ["runSmokeTest"] },
      ],
    },
  },
]);

define.fmt({
  ignorePatterns: ["rstack-editor/**"],
});
