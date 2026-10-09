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
  ]),
  {
    // The Fluid Functionalism registry files are vendored, not ours: they are
    // reinstalled by `npx shadcn@latest add @fluid/<name> --overwrite`, which
    // would silently discard any fix written into them. The React Compiler
    // lint rules flag patterns those files rely on deliberately (a ref mirror
    // assigned during render, a component defined inside another). So the
    // rules that only make sense for first-party code are off for them.
    files: [
      "src/components/ui/**",
      "src/components/fluid-hover-highlight.tsx",
      "src/hooks/use-fluid-hover.ts",
      "src/hooks/use-touch-primary.tsx",
      "src/lib/{springs,font-weight,type-scale,surface-classes}.ts",
      "src/lib/{shape-context,size-context,surface-context,icon-context,elevated}.tsx",
    ],
    rules: {
      "react-hooks/static-components": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
]);

export default eslintConfig;
