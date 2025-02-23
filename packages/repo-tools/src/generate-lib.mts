import fs from 'node:fs';
import path from 'node:path';

import prettier from '@prettier/sync';
import type {
  AnalyzeOptions,
  ScopeManager,
  Variable,
} from '@typescript-eslint/scope-manager';
import { analyze } from '@typescript-eslint/scope-manager';
import type { TSESTree } from '@typescript-eslint/types';
import { AST_TOKEN_TYPES } from '@typescript-eslint/types';
import type { TSESTreeOptions } from '@typescript-eslint/typescript-estree';
import { parse } from '@typescript-eslint/typescript-estree';
import { ESLint } from '@typescript-eslint/utils/ts-eslint';
import { rimraf } from 'rimraf';
import ts from 'typescript';

import { PACKAGES_SCOPE_MANAGER, PACKAGES_TYPES, REPO_ROOT } from './paths.mts';

function parseAndAnalyze(
  code: string,
  analyzeOptions: AnalyzeOptions,
  parserOptions: TSESTreeOptions,
): {
  ast: ReturnType<typeof parse>;
  scopeManager: ReturnType<typeof analyze>;
} {
  const ast = parse(code, { ...parserOptions });
  const scopeManager = analyze(ast, analyzeOptions);

  return { ast, scopeManager };
}

const libMap = new Map(ts.libMap);
// add the "full" libs as well - these are used by the default config resolution system
for (const [lib] of ts.libMap) {
  if (
    (/^es2\d{3}$/.test(lib) || lib === 'esnext') &&
    // there's no "full" lib for es2015
    lib !== 'es2015'
  ) {
    libMap.set(`${lib}.full`, `lib.${lib}.full.d.ts`);
  }
}
// the base lib used when the target is unknown
libMap.set('lib', 'lib.d.ts');

function addAutoGeneratedComment(code: string[]): string {
  return [
    '// THIS CODE WAS AUTOMATICALLY GENERATED',
    '// DO NOT EDIT THIS CODE BY HAND',
    '// RUN THE FOLLOWING COMMAND FROM THE WORKSPACE ROOT TO REGENERATE:',
    '// npx nx generate-lib @typescript-eslint/repo-tools',
    '',
    ...code,
  ].join('\n');
}

const PRETTIER_CONFIG = prettier.resolveConfig(REPO_ROOT);
const TS_LIB_FOLDER = path.join(REPO_ROOT, 'node_modules', 'typescript', 'lib');
const OUTPUT_FOLDER = path.join(PACKAGES_SCOPE_MANAGER, 'src', 'lib');
const TYPES_FILE = path.join(PACKAGES_TYPES, 'src', 'lib.ts');
const BARREL_PATH = path.join(OUTPUT_FOLDER, 'index.ts');

const BASE_CONFIG_MODULE_NAME = 'base-config';
const SHARED_CONFIG_MODULE = path.join(
  OUTPUT_FOLDER,
  `${BASE_CONFIG_MODULE_NAME}.ts`,
);
enum BASE_CONFIG_EXPORT_NAMES {
  TYPE = 'TYPE',
  VALUE = 'VALUE',
  TYPE_AND_VALUE = 'TYPE_VALUE',
}

function formatCode(code: string[]): string {
  return prettier.format(addAutoGeneratedComment(code), {
    parser: 'typescript',
    ...PRETTIER_CONFIG,
  });
}

function sanitize(name: string): string {
  return name.replace(/\./g, '_');
}

function getVariablesFromScope(scopeManager: ScopeManager): Variable[] {
  const scope = scopeManager.globalScope!.childScopes[0];
  const variables: Variable[] = [];
  for (const variable of scope.variables) {
    if (variable.isTypeVariable) {
      variables.push(variable);
    }
  }

  return variables;
}

const REFERENCE_REGEX = /\/ <reference lib="(.+)" \/>/;
function getReferences(
  ast: TSESTree.Program & { comments?: TSESTree.Comment[] },
): Set<string> {
  const comments = ast.comments!.filter(
    c =>
      c.type === AST_TOKEN_TYPES.Line &&
      c.value.startsWith('/ <reference lib="'),
  );

  const references = new Set<string>();
  for (const comment of comments) {
    const match = REFERENCE_REGEX.exec(comment.value);
    if (!match) {
      continue;
    }

    references.add(match[1]);
  }
  return references;
}

async function main(): Promise<void> {
  try {
    rimraf.sync(OUTPUT_FOLDER);
  } catch {
    // ignored
  }
  try {
    fs.mkdirSync(OUTPUT_FOLDER);
  } catch {
    // ignored
  }

  const filesWritten: string[] = [
    SHARED_CONFIG_MODULE,
    TYPES_FILE,
    BARREL_PATH,
  ];

  // the shared
  fs.writeFileSync(
    SHARED_CONFIG_MODULE,
    formatCode([
      `export const ${
        BASE_CONFIG_EXPORT_NAMES.TYPE
      } = Object.freeze(${JSON.stringify({
        eslintImplicitGlobalSetting: 'readonly',
        isTypeVariable: true,
        isValueVariable: false,
      })});`,
      `export const ${
        BASE_CONFIG_EXPORT_NAMES.VALUE
      } = Object.freeze(${JSON.stringify({
        eslintImplicitGlobalSetting: 'readonly',
        isTypeVariable: false,
        isValueVariable: true,
      })});`,
      `export const ${
        BASE_CONFIG_EXPORT_NAMES.TYPE_AND_VALUE
      } = Object.freeze(${JSON.stringify({
        eslintImplicitGlobalSetting: 'readonly',
        isTypeVariable: true,
        isValueVariable: true,
      })});`,
      '',
    ]),
  );

  for (const [libName, filename] of libMap) {
    const libPath = path.join(TS_LIB_FOLDER, filename);
    const { ast, scopeManager } = parseAndAnalyze(
      fs.readFileSync(libPath, 'utf8'),
      {
        // we don't want any libs
        lib: [],
        sourceType: 'module',
      },
      {
        comment: true,
        loc: true,
        range: true,
      },
    );

    const code = [`export const ${sanitize(libName)} = {`];

    const references = getReferences(ast);
    if (references.size > 0) {
      // add a newline before the export
      code.unshift('');
    }

    // import and spread all of the references
    const imports = [
      "import type { ImplicitLibVariableOptions } from '../variable';",
    ];
    for (const reference of references) {
      const name = sanitize(reference);
      imports.push(`import { ${name} } from './${reference}'`);
      code.push(`...${name},`);
    }

    const requiredBaseImports = new Set<BASE_CONFIG_EXPORT_NAMES>();

    // add a declaration for each variable
    const variables = getVariablesFromScope(scopeManager);
    for (const variable of variables) {
      const importName = ((): BASE_CONFIG_EXPORT_NAMES => {
        if (variable.isTypeVariable && variable.isValueVariable) {
          return BASE_CONFIG_EXPORT_NAMES.TYPE_AND_VALUE;
        } else if (variable.isTypeVariable) {
          return BASE_CONFIG_EXPORT_NAMES.TYPE;
        } else if (variable.isValueVariable) {
          return BASE_CONFIG_EXPORT_NAMES.VALUE;
        }
        // shouldn't happen
        throw new Error(
          "Unexpected variable that's is not a type or value variable",
        );
      })();
      requiredBaseImports.add(importName);

      code.push(`'${variable.name}': ${importName},`);
    }
    code.push('} as Record<string, ImplicitLibVariableOptions>;');

    if (requiredBaseImports.size > 0) {
      imports.push(
        `import {${Array.from(requiredBaseImports)
          .sort()
          .join(',')}} from './${BASE_CONFIG_MODULE_NAME}';`,
      );
    }

    if (imports.length > 0) {
      code.unshift(...imports, '');
    }

    const formattedCode = formatCode(code);
    const writePath = path.join(OUTPUT_FOLDER, `${libName}.ts`);
    fs.writeFileSync(writePath, formattedCode);
    filesWritten.push(writePath);

    console.log(
      'Wrote',
      variables.length,
      'variables, and',
      references.size,
      'references for',
      libName,
    );
  }

  // generate and write a barrel file
  const barrelImports = []; // use a separate way so everything is in the same order
  const barrelCode = ['', `const lib = {`];
  for (const lib of libMap.keys()) {
    const name = sanitize(lib);
    if (name === 'lib') {
      barrelImports.push(`import { lib as libBase } from './${lib}'`);
      barrelCode.push(`'${lib}': libBase,`);
    } else {
      barrelImports.push(`import { ${name} } from './${lib}'`);
      barrelCode.push(lib === name ? `${lib},` : `'${lib}': ${name},`);
    }
  }
  barrelCode.unshift(...barrelImports);
  barrelCode.push('} as const;');

  barrelCode.push('', 'export { lib };');

  const formattedBarrelCode = formatCode(barrelCode);

  fs.writeFileSync(BARREL_PATH, formattedBarrelCode);
  console.log('Wrote barrel file');

  // generate a string union type for the lib names

  const libUnionCode = [
    `type Lib = ${Array.from(libMap.keys())
      .map(k => `'${k}'`)
      .join(' | ')};`,
    '',
    'export { Lib };',
  ];
  const formattedLibUnionCode = formatCode(libUnionCode);

  fs.writeFileSync(TYPES_FILE, formattedLibUnionCode);
  console.log('Wrote Lib union type file');

  const lint = new ESLint({
    fix: true,
  });
  const results = await lint.lintFiles(filesWritten);
  await ESLint.outputFixes(results);
  console.log('Autofixed lint errors');
}

main().catch(e => {
  console.error(e);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
