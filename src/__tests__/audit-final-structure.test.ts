// @vitest-environment node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
import { expect, it } from "vitest";

const removed = [
  "AllocationChart", "DailyChangeChart", "EarningsCalendar", "FearGreedIndex", "PortfolioGoal", "PortfolioHeader",
  "PortfolioHeatmap", "PortfolioMetrics", "ProfitByStock", "RankedPositions", "TopMovers", "MarketTicker", "NavLink",
  ...["accordion", "alert-dialog", "alert", "aspect-ratio", "avatar", "badge", "breadcrumb", "calendar", "carousel", "chart",
    "checkbox", "collapsible", "command", "context-menu", "drawer", "form", "hover-card", "input-otp", "menubar",
    "navigation-menu", "pagination", "popover", "progress", "radio-group", "resizable", "scroll-area", "sidebar", "slider",
    "switch", "table", "textarea", "toggle-group", "toggle"].map(name => `ui/${name}`),
];
const sources = () => readdirSync("src", { recursive: true }).map(String).filter(f => /\.tsx?$/.test(f))
  .map(f => ({ path: `src/${f}`, text: readFileSync(`src/${f}`, "utf8") }));

it("R1 keeps the permitted lint scope free of errors", async () => {
  const results = await new ESLint().lintFiles(["src", "supabase", "scripts"]);
  const excluded = /^(supabase\/functions\/(agent\/|company-data\/|request-fundamentals\/|_shared\/requestBody\.ts)|scripts\/price-worker\.mjs|src\/(components\/assistant\/|contexts\/AssistantChatContext\.tsx|lib\/assistant))/;
  expect(results.filter(r => !excluded.test(relative(process.cwd(), r.filePath).replace(/\\/g, "/")))
    .flatMap(r => r.messages.filter(m => m.severity === 2).map(m => `${r.filePath}:${m.line} ${m.ruleId}`))).toEqual([]);
  // ESLint over the whole project: 15–30 s alone, longer while the full suite runs in parallel.
}, 120_000);

it("R3 removes only modules without static, dynamic or test importers", () => {
  for (const name of removed) expect(existsSync(`src/components/${name}.tsx`)).toBe(false);
  expect(existsSync("src/components/ui/use-toast.ts")).toBe(false);
  const removedPaths = new Set(removed.map(name => resolve(`src/components/${name}`)));
  for (const source of sources()) {
    const ast = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)
        || (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword))) {
        const path = node.text.startsWith("@/") ? resolve("src", node.text.slice(2)) : resolve(source.path, "..", node.text);
        expect(removedPaths.has(path.replace(/\.tsx?$/, ""))).toBe(false);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  for (const name of ["debug-spare.jpg", "tmp-debug.jpg", "temp-safe.jpg", "ignore.png"]) {
    expect(existsSync(`src/assets/${name}`)).toBe(false);
    expect(sources().filter(s => !s.path.endsWith("audit-final-structure.test.ts")).some(s => s.text.includes(name))).toBe(false);
  }
  // Parses every source file: allowed to be slow under a full parallel run.
}, 60_000);

it("R5 loads the statement importer through lazy and Suspense on both pages", () => {
  for (const page of ["Index", "Accounts"]) {
    const source = readFileSync(`src/pages/${page}.tsx`, "utf8");
    expect(source).toContain("lazy(() => import('@/components/StatementImport'))");
    expect(source).toMatch(/<Suspense[\s\S]*<StatementImport\s*\/>[\s\S]*<\/Suspense>/);
    expect(source).not.toMatch(/import StatementImport from/);
  }
  const parser = readFileSync("src/lib/statementImport.ts", "utf8");
  expect(parser).toContain('await import("xlsx")');
  expect(parser).toContain('await import("pdfjs-dist")');
});
