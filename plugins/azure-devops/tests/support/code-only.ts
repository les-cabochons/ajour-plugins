/**
 * The source with its comments, strings, template text and regular
 * expressions blanked, so a purity check sees code only: a comment saying
 * "no fetch" must not fail it, and a string holding "fetch" must not hide it.
 * Template `${...}` expressions stay, since they run.
 */
export function withoutCommentsAndStrings(source: string) {
  let out = "";
  const templates: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let previous = ""; // the last code character that is not whitespace
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  function skipTemplateText() {
    const start = i;
    while (i < source.length && source[i] !== "`" && !(source[i] === "$" && source[i + 1] === "{")) {
      i += source[i] === "\\" ? 2 : 1;
    }
    out += blank(source.slice(start, i));
    if (source[i] === "`") {
      out += " ";
      i += 1;
    } else if (i < source.length) {
      out += "  ";
      i += 2;
      templates.push(depth);
      depth += 1;
    }
  }
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (char === '"' || char === "'") {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== char && source[i] !== "\n") {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      out += blank(source.slice(start, i));
      previous = char;
    } else if (char === "`") {
      out += " ";
      i += 1;
      skipTemplateText();
      previous = "`";
    } else if (char === "}" && templates.length > 0 && templates.at(-1) === depth - 1) {
      templates.pop();
      depth -= 1;
      out += " ";
      i += 1;
      skipTemplateText();
    } else if (char === "/" && (previous === "" || "(,=:[!&|?{};".includes(previous))) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < source.length && source[i] !== "\n" && (inClass || source[i] !== "/")) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        i += 1;
      }
      i += 1;
      while (/[a-z]/.test(source[i] ?? "")) i += 1;
      out += blank(source.slice(start, i));
      previous = "/";
    } else {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      out += char;
      if (!/\s/.test(char)) previous = char;
      i += 1;
    }
  }
  return out;
}
