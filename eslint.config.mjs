import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["lib/**", "node_modules/**", "examples/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The reason this plugin is here: it catches the dependency-array
      // mistakes that are easy to make and hard to spot in a hook-based
      // library, including a deps list whose length can vary between renders.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // The package deliberately crosses into untyped territory in a few
      // places — the injected WebRTC module and zod's internals — so `any` is
      // a warning to keep visible rather than an error to work around.
      "@typescript-eslint/no-explicit-any": "warn",

      // Unused args are fine when they document a signature; require a leading
      // underscore to say so on purpose.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  {
    files: ["test/**/*.cjs", "plugin/**/*.js", "app.plugin.js"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "writable",
        __dirname: "readonly",
        process: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "no-undef": "off",
    },
  },
);
