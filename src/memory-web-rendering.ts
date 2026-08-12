import { MEMORY_PAGE_DEFINITIONS, readMemoryPage, saveMemoryOverride } from "./memory-overrides.js";

export { MEMORY_PAGE_DEFINITIONS, readMemoryPage, saveMemoryOverride };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character] ?? character));
}

/** Render the deliberately small Markdown subset used by working memory. */
export function renderMemoryMarkdown(markdown: string): string {
  const inline = (value: string) => escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<span class=\"link\">$1</span>");
  const blocks: string[] = [];
  let items: string[] = [];
  let inComment = false;
  const flushList = () => {
    if (items.length) blocks.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    items = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.includes("<!--")) {
      inComment = !line.includes("-->");
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      items.push(line.replace(/^\s*-\s+/, ""));
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else blocks.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return blocks.join("");
}
