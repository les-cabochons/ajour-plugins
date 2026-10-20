/**
 * Rewrites what `pattern` matches in Markdown text, but not inside code: a
 * fenced block, or a code span on one line. A mention written as an example
 * in code stays the text it is.
 */
export function replaceOutsideCode(
  markdown: string,
  pattern: RegExp,
  replace: (match: string, ...groups: string[]) => string,
): string {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
          fence = undefined;
        }
        return line;
      }
      if (marker && !(marker[0] === "`" && line.slice(line.indexOf(marker) + marker.length).includes("`"))) {
        fence = marker;
        return line;
      }
      return replaceOutsideCodeSpans(line, pattern, replace);
    })
    .join("\n");
}

function replaceOutsideCodeSpans(
  line: string,
  pattern: RegExp,
  replace: (match: string, ...groups: string[]) => string,
) {
  let result = "";
  let at = 0;
  const runs = /`+/g;
  for (let open = runs.exec(line); open; open = runs.exec(line)) {
    // An odd run of backslashes before a backtick makes it text, not a code span.
    let backslashes = 0;
    for (let before = open.index - 1; before >= 0 && line[before] === "\\"; before -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    const close = new RegExp(`(?<!\`)${"`".repeat(open[0].length)}(?!\`)`, "g");
    close.lastIndex = open.index + open[0].length;
    const end = close.exec(line);
    if (!end) continue;
    result += line.slice(at, open.index).replace(pattern, replace) + line.slice(open.index, end.index + end[0].length);
    at = end.index + end[0].length;
    runs.lastIndex = at;
  }
  return result + line.slice(at).replace(pattern, replace);
}
