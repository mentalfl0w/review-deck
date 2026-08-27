const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  rs: "rs",
  go: "go",
  py: "py",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  kt: "kt",
  kts: "kt",
  swift: "swift",
  rb: "rb",
  php: "php",
  cs: "cs",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
  md: "md",
};

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  rs: "rust",
  go: "go",
  py: "python",
  c: "c",
  cpp: "c++",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  cs: "c#",
  sh: "shell",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  html: "html",
  css: "css",
  md: "markdown",
};

function languageFromPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
}

function displayLanguage(language: string): string {
  return LANGUAGE_DISPLAY_NAMES[language] ?? language;
}

const DECLARATION_KEYWORDS: Record<string, true> = {
  function: true, fn: true, func: true, def: true, class: true, struct: true, enum: true,
  trait: true, impl: true, interface: true, type: true, protocol: true, extension: true,
  namespace: true, mod: true,
};

const CONTROL_KEYWORDS: Record<string, true> = {
  if: true, for: true, while: true, switch: true, catch: true, match: true, return: true,
  else: true, do: true, case: true, try: true, finally: true, guard: true, where: true,
  with: true, new: true, throw: true, await: true, yield: true, import: true, from: true,
  use: true, break: true, continue: true, delete: true, typeof: true, instanceof: true,
  void: true, in: true, of: true, as: true, is: true, select: true, defer: true, go: true,
};

const PAREN_SKIP_KEYWORDS: Record<string, true> = {
  ...CONTROL_KEYWORDS,
  ...DECLARATION_KEYWORDS,
  const: true, let: true, var: true, pub: true, static: true, async: true, export: true,
  default: true, public: true, private: true, protected: true, extern: true, unsafe: true,
  abstract: true, final: true, sealed: true, override: true, inline: true, virtual: true,
  template: true, typename: true, mutable: true, auto: true, lock: true, expect: true,
  assert: true, describe: true, it: true, test: true, should: true, Object: true, JSON: true,
  Math: true, Promise: true, Array: true, String: true, Number: true, Date: true, Boolean: true,
  Symbol: true, console: true, document: true, window: true, process: true, Buffer: true,
  require: true, define: true, setTimeout: true, setInterval: true, fetch: true, Error: true,
  map: true, filter: true, reduce: true, forEach: true, then: true, some: true, every: true,
};

const DECLARATION_PREFIX = new RegExp(
  `^(?:(?:export|default|async|static|abstract|final|sealed|public|private|protected|override|virtual|inline|unsafe|extern|pub(?:\\([^)]*\\))?|global|readonly|mut|const|let|var)\\s+)*(${Object.keys(DECLARATION_KEYWORDS).join("|")})\\b`,
);

// Reduce an extracted function-context line to its bare symbol, e.g. "fn pointAdd(" -> "pointAdd()".
function symbolFromText(text: string): string {
  const trimmed = text.trim();
  const paren = /([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = paren.exec(trimmed)) !== null) {
    if (PAREN_SKIP_KEYWORDS[match[1]] === true) continue;
    return `${match[1]}()`;
  }
  const assigned = /(?:^|[\s=(,:])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(trimmed);
  if (assigned) return `${assigned[1]}()`;
  return trimmed;
}

// Lightweight heuristic: does a single diff line (context, added, or removed) look like a
// function/type declaration? Returns the enclosing symbol or undefined. Never throws.
function enclosingSymbolFromLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (/^(?:\/\/|#|\/\*|\*|--)/.test(trimmed)) return undefined;
  const firstToken = /^[A-Za-z_$][\w$]*/.exec(trimmed)?.[0];
  if (firstToken && CONTROL_KEYWORDS[firstToken] === true) return undefined;
  const decl = DECLARATION_PREFIX.exec(trimmed);
  if (decl) {
    const rest = trimmed.slice(decl[0].length).trim();
    const name = /^[A-Za-z_$][\w$]*/.exec(rest)?.[0];
    if (name) {
      const keyword = decl[1];
      if (keyword === "function" || keyword === "fn" || keyword === "func" || keyword === "def") {
        return `${name}()`;
      }
      return name;
    }
    return symbolFromText(trimmed);
  }
  if (!trimmed.includes("{") && !trimmed.includes("=>")) return undefined;
  const paren = /([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = paren.exec(trimmed)) !== null) {
    const token = match[1];
    if (PAREN_SKIP_KEYWORDS[token] === true) continue;
    if (match.index > 0 && /[.\w$#]/.test(trimmed[match.index - 1])) continue;
    return `${token}()`;
  }
  if (trimmed.includes("=>")) {
    const assigned = /(?:^|[\s=(,:])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(trimmed);
    if (assigned) return `${assigned[1]}()`;
  }
  return undefined;
}

function functionContextFromHeader(header: string): string | undefined {
  const match = /^@@ [^@]+ @@\s*(.*)$/.exec(header);
  const tail = match?.[1]?.trim();
  return tail || undefined;
}

function functionHintForHunk(header: string, lines: string[]): string | undefined {
  const tail = functionContextFromHeader(header);
  if (tail) return symbolFromText(tail);
  // No git function context: scan the hunk's own lines top-to-bottom (context, added, and
  // removed) for the nearest function-definition-shaped line. Safe degrade to undefined.
  for (const line of lines) {
    const hint = enclosingSymbolFromLine(line);
    if (hint !== undefined) return hint;
  }
  return undefined;
}

export {
  LANGUAGE_BY_EXTENSION,
  LANGUAGE_DISPLAY_NAMES,
  languageFromPath,
  displayLanguage,
  symbolFromText,
  enclosingSymbolFromLine,
  functionContextFromHeader,
  functionHintForHunk,
};
