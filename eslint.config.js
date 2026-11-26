import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["coverage/", "public/data/"] },
  js.configs.recommended,
  {
    // Browser modules. MapLibre GL JS is loaded as a classic script in index.html.
    files: ["public/js/**/*.js"],
    languageOptions: { globals: { ...globals.browser, maplibregl: "readonly" } },
  },
  {
    files: ["*.js", "api/**/*.js", "lib/**/*.js", "scripts/**/*.js", "test/**/*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      eqeqeq: ["error", "always"],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];
