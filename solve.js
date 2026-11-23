// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Implements the same build as the reference (README + reference code in the kit),
// written from scratch for speed: template codegen to JS functions, a fused
// single-pass Markdown renderer, index-based inline scanning, memoized slugs,
// and no per-node allocations in the hot paths. Pure JS, no dependencies.
// Every run(input) is self-contained: no state is kept between cases.

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** HTML escape; returns the input untouched when it holds nothing to escape. */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return text;
  return out + text.slice(last);
}

const SLUG_MAX = 64;
const COMBINING = /\p{M}/gu;
/** Slug of text: NFKD, combining marks dropped, A-Z lowered, runs of other
 *  characters one '-', none at either end, cut to 64 (a '-' at the cut dropped),
 *  'untitled' when nothing is left. Memoized per build through `memo`. */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** A null-prototype object holding `fields` (own properties only, so template
 *  paths never read Object.prototype). */
function obj(fields) {
  const o = Object.create(null);
  for (const k in fields) o[k] = fields[k];
  return o;
}

/* ------------------------------------------------------------ front matter */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Parses `lines` (the whole source, '\n' ends) front matter; returns
 *  { data, close } with `close` the index of the closing '---', or { error }. */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue; // '#'
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

/* --------------------------------------------------------------- markdown */

const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
/** Next special inline character from `from` (a backslash escape, backtick,
 *  star, '[', or a character the escape table names), or -1. */
const MD_SPECIAL = /[\\`*\[]|[&<>"']/g;

function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlank(line) {
  for (let j = 0; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return MD_FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return MD_HR.test(line);
  return false;
}

const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/** First index >= `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const last = end - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single '*' from `from` (one whose run is not '**'), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Renders `s[start..end)` inline into `out` (an array of strings). */
function inline(s, start, end, link, out) {
  MD_SPECIAL.lastIndex = start;
  let last = start;
  let m;
  while ((m = MD_SPECIAL.exec(s)) !== null && m.index < end) {
    const i = m.index;
    const c = m[0];
    if (i > last) out.push(s.slice(last, i));
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out.push(ESCAPES[c]);
      last = i + 1;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < end && ESCAPABLE.has(s[i + 1])) {
        out.push(ESCAPES[s[i + 1]] ?? s[i + 1]);
        last = i + 2;
      } else {
        out.push('\\');
        last = i + 1;
      }
      MD_SPECIAL.lastIndex = last;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        last = j + 1;
      } else {
        out.push('`');
        last = i + 1;
      }
      MD_SPECIAL.lastIndex = last;
      continue;
    }
    if (c === '*') {
      if (i + 1 < end && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          out.push('<strong>');
          inline(s, i + 2, j, link, out);
          out.push('</strong>');
          last = j + 2;
        } else {
          out.push('**');
          last = i + 2;
        }
      } else {
        const j = findSingleStar(s, i + 1, end);
        if (j > i + 1) {
          out.push('<em>');
          inline(s, i + 1, j, link, out);
          out.push('</em>');
          last = j + 1;
        } else {
          out.push('*');
          last = i + 1;
        }
      }
      MD_SPECIAL.lastIndex = last;
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1, end);
    const mm = k !== -1 && k + 1 < end && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm !== -1 && mm < end ? s.slice(k + 2, mm) : '';
    if (mm !== -1 && mm < end && target !== '' && !/\s/.test(target)) {
      out.push('<a href="', escapeHtml(link(target)), '">');
      inline(s, i + 1, k, link, out);
      out.push('</a>');
      last = mm + 1;
    } else {
      out.push('[');
      last = i + 1;
    }
    MD_SPECIAL.lastIndex = last;
  }
  if (last < end) out.push(s.slice(last, end));
}

/**
 * Renders the body lines `lines[lo..hi)` to HTML; `link` resolves link targets.
 * Returns { html, toc, excerpt }. `slugMemo` is the build's slug cache.
 */
function renderMarkdown(lines, lo, hi, link, slugMemo) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0) {
      i++;
      continue;
    }
    if (c0 === 32 || c0 === 9) {
      // Blank (all spaces/tabs) or a paragraph line: no other block opens on one.
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      // '`': only a fence can open here.
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        out.push(`<pre><code${cls}>`);
        while (i < hi && !isFenceClose(lines[i])) {
          out.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      // '#': only a heading can open here.
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugMemo), ids);
        const parts = [];
        inline(heading.text, 0, heading.text.length, link, parts);
        const html = parts.join('');
        out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push(obj({ level: heading.depth, id, html }));
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      // '-' or '*': a thematic break first, then a bullet list.
      if (MD_HR.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const bullet = MD_BULLET.exec(line);
      if (bullet !== null) {
        renderList(out, lines, i, hi, false, bullet, link);
        i = renderList.next;
        continue;
      }
    } else if (c0 === 62) {
      // '>': a blockquote.
      const body = [];
      while (i < hi && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = body.map(trimLine).filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        const parts = [];
        inline(joined, 0, joined.length, link, parts);
        out.push('<blockquote>\n<p>', parts.join(''), '</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      // A digit: only an ordered list can open here.
      const ordered = MD_ORDERED.exec(line);
      if (ordered !== null) {
        renderList(out, lines, i, hi, true, ordered, link);
        i = renderList.next;
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < hi && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const parts = [];
    inline(text, 0, text.length, link, parts);
    const html = parts.join('');
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/** Renders a list starting at `lines[i]` (whose first line already matched
 *  `first`); appends its HTML to `out`. Leaves the next index in renderList.next. */
function renderList(out, lines, i, hi, isOrdered, first, link) {
  const marker = isOrdered ? MD_ORDERED : MD_BULLET;
  const items = [[trimLine(isOrdered ? first[2] : first[1])]];
  i++;
  while (i < hi) {
    const l = lines[i];
    const mm = marker.exec(l);
    if (mm !== null) {
      items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
      i++;
    } else if (l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32 && MD_CONTINUED.test(l)) {
      items[items.length - 1].push(trimLine(l));
      i++;
    } else break;
  }
  const tag = isOrdered ? 'ol' : 'ul';
  const start = isOrdered ? Number(first[1]) : 1;
  out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
  for (const parts of items) {
    const joined = parts.join('\n');
    const ip = [];
    inline(joined, 0, joined.length, link, ip);
    out.push('<li>', ip.join(''), '</li>\n');
  }
  out.push(`</${tag}>\n`);
  renderList.next = i;
}

/* -------------------------------------------------------------- templates */

const INCLUDE_DEPTH = 8;
const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const TPL_WS = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Tokenizes a template source: text, {{ }}/{{{ }}} and {% %} tags. A {% %} tag
 *  alone on its line takes the whole line with it, newline included. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = TPL_WS.test(src.slice(lineStart, open)) && TPL_WS.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Parses a template source into a node tree (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** Own-property get of `k` on object `v` (undefined when v is not an object). */
function G(v, k) {
  return v !== null && typeof v === 'object' ? v[k] : undefined;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false,
 *  an array's items joined by ', ', anything else ''. */
function TX(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(TX).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, '', 0
 *  or an empty array. */
function TY(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in scope frame `S` (first name via the frame chain, the
 *  rest own properties of the value so far). */
function lookupFrame(S, path) {
  let v = S[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[path[k]];
  }
  return v;
}

/** Tree-walking renderer (fallback when code generation is unavailable). */
function renderNodes(nodes, S, D, T, G, TX, TY, E) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += E(TX(lookupFrame(S, n.path)));
        break;
      case 'raw':
        out += TX(lookupFrame(S, n.path));
        break;
      case 'if': {
        const v = TY(lookupFrame(S, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, S, D, T, G, TX, TY, E);
        break;
      }
      case 'for': {
        const xs = lookupFrame(S, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const f = Object.create(S);
          f[n.name] = xs[k];
          f.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          out += renderNodes(n.body, f, D, T, G, TX, TY, E);
        }
        break;
      }
      case 'include': {
        const t = T.get(n.name);
        if (t !== undefined && D < INCLUDE_DEPTH) out += t(S, D + 1, T, G, TX, TY, E);
        break;
      }
    }
  }
  return out;
}

/** JS expression for the value at `path` in scope variable `s`. */
function pathExpr(path, s) {
  let e = `${s}.${path[0]}`;
  for (let k = 1; k < path.length; k++) e = `G(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** Compiles a parsed template to a render function (S, D, T, G, TX, TY, E) => string. */
function compileTemplate(nodes) {
  let src = 'var O="";\n';
  let uid = 0;
  const gen = (ns, s) => {
    for (const n of ns) {
      if (n.kind === 'text') src += `O+=${JSON.stringify(n.text)};\n`;
      else if (n.kind === 'var') src += `O+=E(TX(${pathExpr(n.path, s)}));\n`;
      else if (n.kind === 'raw') src += `O+=TX(${pathExpr(n.path, s)});\n`;
      else if (n.kind === 'if') {
        src += `if(TY(${pathExpr(n.path, s)})!==${n.not}){\n`;
        gen(n.then, s);
        if (n.else !== null) {
          src += '}else{\n';
          gen(n.else, s);
        }
        src += '}\n';
      } else if (n.kind === 'for') {
        const u = uid++;
        src += `{var _x${u}=${pathExpr(n.path, s)};if(Array.isArray(_x${u})){var _f${u}=Object.create(${s});var _l${u}={index:0,first:false,last:false,length:_x${u}.length};for(var _k${u}=0;_k${u}<_x${u}.length;_k${u}++){_l${u}.index=_k${u}+1;_l${u}.first=_k${u}===0;_l${u}.last=_k${u}===_x${u}.length-1;_f${u}.${n.name}=_x${u}[_k${u}];_f${u}.loop=_l${u};\n`;
        gen(n.body, `_f${u}`);
        src += '}}}\n';
      } else if (n.kind === 'include') {
        const u = uid++;
        src += `{var _t${u}=T.get(${JSON.stringify(n.name)});if(_t${u}!==undefined&&D<8)O+=_t${u}(${s},D+1,T,G,TX,TY,E);}\n`;
      }
    }
  };
  gen(nodes, 'S');
  src += 'return O;';
  try {
    return new Function('S', 'D', 'T', 'G', 'TX', 'TY', 'E', src);
  } catch {
    return (S, D, T, G, TX, TY, E) => renderNodes(nodes, S, D, T, G, TX, TY, E);
  }
}

/* ------------------------------------------------------------------ build */

const LINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function wordsOf(s) {
  let n = 0;
  for (let i = s.bodyStart; i < s.lines.length; i++) {
    const line = s.lines[i];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      let sp;
      if (c < 33) sp = c === 32 || (c >= 9 && c <= 13);
      else if (c < 127) sp = false;
      else {
        // JS \s above ASCII: 0x85, 0xa0, 0x1680, 0x2000-0x200a, 0x2028-0x2029, 0x202f, 0x205f, 0x3000, 0xfeff
        sp =
          c === 0x85 ||
          c === 0xa0 ||
          c === 0x1680 ||
          (c >= 0x2000 && c <= 0x200a) ||
          c === 0x2028 ||
          c === 0x2029 ||
          c === 0x202f ||
          c === 0x205f ||
          c === 0x3000 ||
          c === 0xfeff;
      }
      if (sp) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugMemo = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths, line ends made '\n'.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    else statics.push(f);
  }

  // 2. Front matter, in order: refused, the generator's own directory, a post
  //    with no date, a layout that is no template, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugMemo), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each source's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (LINK_SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, link, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.wordCount = wordsOf(s);
  }

  // 5. Collections: posts newest first, equal dates by slug; newer and older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, each named as first met walking the posts in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name, slugMemo);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugMemo);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page, the index pages, the tag pages, the tags page.
  const linkOf = (s) =>
    s === null
      ? null
      : obj({ title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) =>
    obj({
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.wordCount / 200)),
      tags: s.tagRefs.map((t) => obj({ name: t.name, slug: t.slug, url: t.url })),
    });
  const pageOf = (s) => {
    const c = cardOf(s);
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc;
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = obj({ title: input.site.title, base_url: base });
  const allTags = tags.map((t) => obj({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const V = obj({ site, tags: allTags, recent });
    for (const k in vars) V[k] = vars[k];
    return fn(V, 0, templates, G, TX, TY, escapeHtml);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: obj({ number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) }),
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: obj({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) }),
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
