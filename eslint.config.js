import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import unicorn from "eslint-plugin-unicorn";
import prettier from "eslint-config-prettier";

export default defineConfig([
  {
    ignores: ["build/**", "standalone-executables/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat["recommended-latest"],
  unicorn.configs["recommended"],
  prettier,
  {
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      "linebreak-style": ["error", "unix"],
      quotes: ["error", "double", { avoidEscape: true }],
      semi: ["error", "always"],
      "no-ternary": "error",
      "react/no-multi-comp": "error",
    },
  },
  {
    // The browser UI is JSX-heavy, where a conditional expression is the
    // idiomatic form and an if block is not available inside markup.
    files: ["web/**/*.tsx"],
    rules: {
      "no-ternary": "off",
      "react/no-multi-comp": "off",
    },
  },
]);
