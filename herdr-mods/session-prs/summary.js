// A pull request's summary for its hover card: the body's Summary section, or the text before its
// first heading when it has none, as plain lines. Lines that are only a link are left out, and so is
// any HTML comment, which takes a bot's whole <!-- CURSOR_SUMMARY --> block with it.

const MAX = 1200;
const LINK_ONLY = /^\s*(<?https?:\/\/\S+>?|\[[^\]]*\]\(https?:\/\/[^)\s]+\))\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s/;

export function summaryOf(body) {
  if (typeof body !== "string") return "";
  const lines = body.replace(/\r/g, "")
    .replace(/<!--\s*CURSOR_SUMMARY\s*-->[\s\S]*?(<!--\s*\/CURSOR_SUMMARY\s*-->|$)/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n");
  const at = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+summary\s*#*\s*$/i.test(l));
  const from = at + 1;
  const to = lines.findIndex((l, i) => i >= from && HEADING.test(l));
  const text = lines.slice(from, to < 0 ? lines.length : to)
    .filter((l) => !LINK_ONLY.test(l) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(l))
    .map((l) => l.replace(/\*\*|__|`/g, "").trimEnd())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > MAX ? `${text.slice(0, MAX).trimEnd()}…` : text;
}
