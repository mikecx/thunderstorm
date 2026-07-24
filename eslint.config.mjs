import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // This codebase deliberately uses `any` as a controlled escape hatch
      // for the metaprogramming internals (getAttr/setAttr, decorator
      // machinery) — see the "TypeScript typing notes" section of the README.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // @Delegate/@Enum generate members at runtime that the type checker
      // can't see; the documented (README) way to type them is exactly the
      // `interface Foo { ... }` alongside `class Foo` pattern this rule
      // flags. We're not hitting the unsound case it guards against (a
      // merged interface property with a type that conflicts with a real
      // class field of the same name).
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
    },
  },
  eslintConfigPrettier
);
