// A small YAML reader for the subset the repository's own files use (admin/openapi.yaml): block mappings and
// sequences, flow mappings and sequences, plain and quoted scalars, folded (>) and literal (|) block scalars, and
// comments. No anchors, tags or multiple documents. Node built-ins only (BUILD-PLAN: no new dependency).

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote && line[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(text) {
  const t = text.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"')) return JSON.parse(t);
  if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

// Flow collections: { a: 1, b: [x, y] }.
function parseFlow(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const quoted = () => {
    const q = text[i];
    let j = i + 1;
    for (;;) {
      if (j >= text.length) throw new Error("yaml: unterminated quoted scalar");
      if (q === '"' && text[j] === "\\") { j += 2; continue; }
      if (text[j] === q) { if (q === "'" && text[j + 1] === "'") { j += 2; continue; } break; }
      j++;
    }
    const raw = text.slice(i, j + 1);
    i = j + 1;
    return scalar(raw);
  };
  const plain = (stops) => {
    const start = i;
    while (i < text.length && !stops.includes(text[i]) && !(text[i] === ":" && /[\s,}\]]/.test(text[i + 1] ?? " "))) i++;
    return scalar(text.slice(start, i));
  };
  const value = () => {
    ws();
    if (text[i] === "{") return map();
    if (text[i] === "[") return seq();
    if (text[i] === '"' || text[i] === "'") return quoted();
    return plain([",", "}", "]"]);
  };
  function map() {
    i++;
    const out = {};
    for (;;) {
      ws();
      if (text[i] === "}") { i++; return out; }
      const key = text[i] === '"' || text[i] === "'" ? quoted() : plain([",", "}", ":"]);
      ws();
      // A flow key without ':' has a null value (YAML 1.2 §7.4): "{ a: x, b c }" reads b c as a key.
      if (text[i] === "," || text[i] === "}") { out[String(key)] = null; if (text[i] === ",") i++; continue; }
      if (text[i] !== ":") throw new Error(`yaml: expected ':' in flow mapping near ${text.slice(i, i + 30)}`);
      i++;
      out[String(key)] = value();
      ws();
      if (text[i] === ",") i++;
    }
  }
  function seq() {
    i++;
    const out = [];
    for (;;) {
      ws();
      if (text[i] === "]") { i++; return out; }
      out.push(value());
      ws();
      if (text[i] === ",") i++;
    }
  }
  const v = value();
  ws();
  if (i !== text.length) throw new Error(`yaml: trailing text after flow value: ${text.slice(i, i + 30)}`);
  return v;
}

function inlineValue(text) {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[") ? parseFlow(t) : scalar(t);
}

// Splits "key: value" at the first ': ' (or trailing ':') outside quotes and flow brackets.
function splitKey(content) {
  let quote = null, depth = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === ":" && depth === 0 && (i + 1 === content.length || content[i + 1] === " ")) {
      return [scalar(content.slice(0, i)), content.slice(i + 1)];
    }
  }
  return null;
}

export function parseYaml(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n").map((raw) => {
    const text = stripComment(raw).replace(/\s+$/, "");
    return { indent: text.length - text.trimStart().length, content: text.trim(), raw };
  });
  let pos = 0;
  const skipBlank = () => { while (pos < lines.length && lines[pos].content === "") pos++; };

  function blockScalar(style, parentIndent) {
    const body = [];
    let indent = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.raw.trim() === "") { body.push(""); pos++; continue; }
      const ind = l.raw.length - l.raw.trimStart().length;
      if (ind <= parentIndent) break;
      indent ??= ind;
      body.push(l.raw.slice(indent));
      pos++;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    const keep = style.endsWith("-") ? "" : "\n";
    if (style.startsWith("|")) return `${body.join("\n")}${keep}`;
    return `${body.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ").replace(/\n\n/g, "\n")}${keep}`;
  }

  function valueAfterKey(rest, keyIndent) {
    const r = rest.trim();
    if (/^[>|]-?$/.test(r)) return blockScalar(r, keyIndent);
    if (r !== "") return inlineValue(r);
    skipBlank();
    if (pos < lines.length && lines[pos].indent > keyIndent) return block(lines[pos].indent);
    if (pos < lines.length && lines[pos].indent === keyIndent && lines[pos].content.startsWith("- ")) return block(keyIndent);
    return null;
  }

  function block(indent) {
    skipBlank();
    if (pos >= lines.length) return null;
    if (lines[pos].content.startsWith("- ") || lines[pos].content === "-") {
      const out = [];
      for (;;) {
        skipBlank();
        const l = lines[pos];
        if (!l || l.indent !== indent || !(l.content.startsWith("- ") || l.content === "-")) break;
        const item = l.content.slice(1).trim();
        const kv = item.startsWith("{") || item.startsWith("[") ? null : splitKey(item);
        if (kv) {
          // "- key: value" opens a mapping whose further keys sit two columns deeper.
          lines[pos] = { indent: indent + 2, content: item, raw: " ".repeat(indent + 2) + item };
          out.push(block(indent + 2));
        } else {
          pos++;
          out.push(item === "" ? block(lines[pos]?.indent ?? indent + 2) : inlineValue(item));
        }
      }
      return out;
    }
    const out = {};
    for (;;) {
      skipBlank();
      const l = lines[pos];
      if (!l || l.indent !== indent || l.content.startsWith("- ")) break;
      const kv = splitKey(l.content);
      if (!kv) throw new Error(`yaml: expected 'key: value' at line ${pos + 1}: ${l.content.slice(0, 40)}`);
      pos++;
      out[String(kv[0])] = valueAfterKey(kv[1], indent);
    }
    return out;
  }

  const result = block(0);
  skipBlank();
  if (pos < lines.length) throw new Error(`yaml: unexpected indentation at line ${pos + 1}`);
  return result;
}
