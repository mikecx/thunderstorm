import ts from 'typescript';
import { defineConfig, type Plugin } from 'vitest/config';

// Vite 8's oxc transform strips TS types but does not lower Stage 3
// decorators, and Node can't run them natively. Lower them with tsc first.
function lowerDecorators(): Plugin {
  return {
    name: 'thunderstorm:lower-decorators',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?ts$/.test(id) || !code.includes('@')) return;
      const out = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          useDefineForClassFields: false, // match tsconfig.json
          sourceMap: true,
          inlineSources: true,
        },
      });
      return { code: out.outputText, map: out.sourceMapText };
    },
  };
}

export default defineConfig({ plugins: [lowerDecorators()] });
