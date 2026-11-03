// A small line-at-a-time highlighter for diffs: keywords, strings, comments, numbers, constants,
// function calls and Ruby symbols. Comments and strings that span lines are only colored on the
// line where they open; good enough for reading a diff.

const JS_KEYWORDS = "await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof interface let new null of return static super switch this throw true try type typeof undefined var void while yield async enum implements private protected public readonly as keyof";
const RUBY_KEYWORDS = "alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield private protected public attr_reader attr_accessor attr_writer require require_relative include extend lambda proc raise let let_it_be describe context it before after expect subject";
const CSS_KEYWORDS = "important media import from to and not only supports keyframes";

const LANGS = {
  js: { keywords: new Set(JS_KEYWORDS.split(" ")), comment: /\/\/.*|\/\*.*?(\*\/|$)/y, string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?/y },
  ruby: { keywords: new Set(RUBY_KEYWORDS.split(" ")), comment: /#(?!\{).*/y, string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y, symbol: /:[A-Za-z_]\w*[?!]?|\b[A-Za-z_]\w*:(?!:)/y },
  css: { keywords: new Set(CSS_KEYWORDS.split(" ")), comment: /\/\*.*?(\*\/|$)|\/\/.*/y, string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y },
  json: { keywords: new Set(["true", "false", "null"]), string: /"(?:\\.|[^"\\])*"?/y },
  yaml: { keywords: new Set(["true", "false", "null", "yes", "no"]), comment: /#.*/y, string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y, symbol: /[\w.-]+(?=:\s|:$)/y },
};

const BY_EXTENSION = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js",
  rb: "ruby", rake: "ruby", erb: "ruby", gemspec: "ruby", ru: "ruby",
  css: "css", scss: "css",
  json: "json",
  yml: "yaml", yaml: "yaml",
};

export function langFor(path) {
  if (/(^|\/)(Gemfile|Rakefile|Guardfile)$/.test(path)) return "ruby";
  return BY_EXTENSION[path.split(".").pop()?.toLowerCase()] ?? null;
}

// GitHub's colors.
export const PALETTES = {
  light: { keyword: "#cf222e", string: "#0a3069", comment: "#6e7781", number: "#0550ae", constant: "#953800", fn: "#8250df", symbol: "#0550ae" },
  dark: { keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", number: "#79c0ff", constant: "#ffa657", fn: "#d2a8ff", symbol: "#79c0ff" },
};

const NUMBER = /\b\d[\d_]*(\.\d+)?\b/y;
const WORD = /[A-Za-z_$][\w$]*[?!]?/y;

// [{ text, kind }] covering the whole line; kind is null for plain text.
export function tokens(line, lang) {
  const rules = LANGS[lang];
  if (!rules) return [{ text: line, kind: null }];
  const out = [];
  const push = (text, kind) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  const at = (re, i) => {
    re.lastIndex = i;
    const m = re.exec(line);
    return m && m.index === i && m[0].length ? m[0] : null;
  };
  let i = 0;
  while (i < line.length) {
    let m;
    if (rules.comment && (m = at(rules.comment, i))) { push(m, "comment"); i += m.length; continue; }
    if ((m = at(rules.string, i))) { push(m, "string"); i += m.length; continue; }
    if (rules.symbol && (m = at(rules.symbol, i))) { push(m, "symbol"); i += m.length; continue; }
    if ((m = at(NUMBER, i))) { push(m, "number"); i += m.length; continue; }
    if ((m = at(WORD, i))) {
      const kind = rules.keywords.has(m) ? "keyword"
        : /^[A-Z]/.test(m) ? "constant"
        : line[i + m.length] === "(" ? "fn"
        : null;
      push(m, kind);
      i += m.length;
      continue;
    }
    push(line[i], null);
    i++;
  }
  return out;
}
