// Pulls every piece of on-screen English out of src/ — JSX text, prose
// attributes (placeholder, title, aria-label…), and prose string literals —
// into scripts/i18n/strings.json. Numbers in templates become {n}.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] ?? "src");
const SKIP_FILE = /(\.test\.|\.testkit\.|\.server\.ts$|\/integrations\/supabase\/types|\/lib\/i18n\/|routeTree\.gen|\.d\.ts$)/;
const NON_PROSE_ATTR = new Set([
  "className","href","id","key","type","variant","size","name","value","src","to","target","rel",
  "role","method","action","htmlFor","form","autoComplete","inputMode","pattern","accept","side",
  "align","orientation","mode","dir","lang","tabIndex","asChild","defaultValue","sizes","fill","stroke",
  "d","viewBox","xmlns","points","transform","from","search","hash","params","slot","encType","color",
]);
const out = new Map();
const add = (s, file) => {
  s = s.replace(/\s+/g, " ").trim();
  if (!looksLikeProse(s)) return;
  if (!out.has(s)) out.set(s, file);
};
function looksLikeProse(s) {
  if (s.length < 2 || s.length > 600) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (/^(https?:|mailto:|tel:|\/|#|\.|@|--|var\(|rgb|hsl|data:)/.test(s)) return false;
  if (/^[a-z0-9_.:/-]+$/.test(s)) return false; // identifiers, keys, paths, slugs
  if (/^[A-Z0-9_]+$/.test(s) && s.length > 3 && s.includes("_")) return false; // CONSTANT_KEYS
  if (/\b(select|insert|update|delete)\b.*\b(from|into|set)\b/i.test(s) && /[,_]/.test(s)) return false;
  // tailwind class lists
  const toks = s.split(" ");
  if (toks.length > 1 && toks.filter((t) => /[-:[\]/]/.test(t) || /^[a-z]+$/.test(t)).length === toks.length && toks.some((t) => /-/.test(t))) return false;
  if (/^[a-z][a-zA-Z0-9]*$/.test(s)) return false; // camelCase id
  if (/[{}<>;=]/.test(s) && !/\{n\}/.test(s)) return false;
  if (/^[\w-]+\.(tsx?|jsx?|png|svg|pdf|csv|json|css)$/.test(s)) return false;
  return true;
}
function tmpl(node) {
  let s = node.head.text;
  for (const sp of node.templateSpans) s += "{n}" + sp.literal.text;
  return s;
}
function attrName(n) {
  return n.name && ts.isIdentifier(n.name) ? n.name.text : n.name?.getText?.() ?? "";
}
function walk(file) {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = path.relative(process.cwd(), file);
  const visit = (n, ctx) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isJsxText(n)) { add(n.text, rel); return; }
    if (ts.isJsxAttribute(n)) {
      const nm = attrName(n);
      if (NON_PROSE_ATTR.has(nm) || nm.startsWith("data-") || nm.startsWith("on")) return;
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (/^(console\.|cn$|clsx|twMerge|require|import|\w+\.(eq|neq|select|from|order|in|is|rpc|channel|on|match|filter|or|ilike|like|contains|single|maybeSingle|getItem|setItem|removeItem|get|has|set|startsWith|endsWith|includes|split|replace|test|querySelector|querySelectorAll|getAttribute|setAttribute|addEventListener|removeEventListener|invalidateQueries|join)$|new Date|Date\.|JSON\.|Number|parseInt|parseFloat|encodeURIComponent|fetch|useQuery|queryKey|cva)/.test(callee)) return;
    }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) return;
    if (ts.isCaseClause(n)) { n.statements.forEach((s) => visit(s, ctx)); return; }
    if (ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return;
    if (ts.isPropertyAssignment(n)) {
      const k = n.name.getText(sf).replace(/["']/g, "");
      if (/^(className|class|id|key|href|to|type|variant|value|icon|color|tone|slug|path|kind|status|role|table|column|scope|queryKey|accent|size)$/.test(k)) return;
    }
    if (ts.isElementAccessExpression(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { add(n.text, rel); return; }
    if (ts.isTemplateExpression(n)) {
      const s = tmpl(n);
      // only templates whose holes look like counts/amounts are worth a pattern
      add(s, rel);
      n.templateSpans.forEach((sp) => visit(sp.expression, ctx));
      return;
    }
    ts.forEachChild(n, (c) => visit(c, ctx));
  };
  visit(sf);
}
function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(tsx|ts)$/.test(e.name) && !SKIP_FILE.test(p)) yield p;
  }
}
for (const f of files(ROOT)) walk(f);
const arr = [...out.keys()].sort();
fs.writeFileSync("scripts/i18n/strings.json", JSON.stringify(arr, null, 0).replace(/","/g, '",\n"'));
console.log(arr.length, "strings");
