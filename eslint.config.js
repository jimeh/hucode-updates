import js from "@eslint/js";
import tseslint from "typescript-eslint";

const browserWorkerGlobals = {
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  URL: "readonly",
};

const nodeGlobals = {
  process: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "eslint.config.js",
      "node_modules/**",
      "public/api/**",
      "src/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: browserWorkerGlobals,
    },
  },
  {
    files: ["scripts/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
