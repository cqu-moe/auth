import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

function filesUnder(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const entry = resolve(path, name);
    return statSync(entry).isDirectory()
      ? filesUnder(entry)
      : /\.(?:ts|tsx)$/.test(name) ? [entry] : [];
  });
}

function resolveLocal(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  }
  return base;
}

export function checkBoundaries(root: string): string[] {
  const errors: string[] = [];
  const backend = resolve(root, "src");
  const frontend = resolve(root, "frontend/src");
  const shared = resolve(root, "shared");
  const inspect = (file: string, area: "frontend" | "shared") => {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        specifier = node.arguments[0].text;
      }
      if (specifier) {
        const target = specifier.startsWith(".") ? resolveLocal(file, specifier) : null;
        if (area === "frontend" && (specifier.startsWith("@/") || target === backend || target?.startsWith(`${backend}/`))) {
          errors.push(`${file}: frontend import resolves into backend src: ${specifier}`);
        }
        if (area === "shared") {
          const packageName = specifier.split("/")[0];
          if (["react", "hono", "drizzle-orm", "cloudflare:workers"].includes(packageName) || (target && !target.startsWith(`${shared}/`))) {
            errors.push(`${file}: shared import is not runtime-neutral: ${specifier}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  for (const file of filesUnder(frontend)) inspect(file, "frontend");
  for (const file of filesUnder(shared)) inspect(file, "shared");
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkBoundaries(resolve(process.argv[2] ?? process.cwd()));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Import boundaries verified");
  }
}
