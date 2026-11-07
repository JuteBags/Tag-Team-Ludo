// Privacy & Terms as HTML (#208), from its Markdown, legal/LEGAL.md: the app's sheet and the website's page
// (tools/legal-site.mjs) render the same text with this. Pure, with no imports, so Node runs it as it is.
// The Markdown is the small part the text uses: "# ", "## " (with an id, its slug) and "### " headings, "- " lists,
// **bold**, paragraphs, and links written out in full (https://...) or as email addresses.

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One line's text: escaped, **bold**, https:// links and email addresses (a trailing full stop or bracket stays outside). */
function inline(s: string): string {
  return escape(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/https?:\/\/[^\s<]+?(?=[.,)]?(\s|$))/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    .replace(/(^|\s)([\w.+-]+@[\w-]+(\.[\w-]+)+?)(?=[.,)]?(\s|$))/g, (_m, pre: string, e: string) => `${pre}<a href="mailto:${e}">${e}</a>`);
}

/** A heading's anchor: "Terms of use" → "terms-of-use" (the site's redirects point at these). */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The text's title (its "# " line). */
export function legalTitle(md: string): string {
  return /^# (.+)$/m.exec(md)?.[1]?.trim() ?? '';
}

/** The version in the text's "Version N · date" line. */
export function legalVersionOf(md: string): number {
  return Number(/^Version (\d+)\b/m.exec(md)?.[1] ?? NaN);
}

/**
 * The text as HTML. `top`: the heading level for "## " parts ("### " sections are one below; the app's sheet has
 * its own title, so its parts are h3); the "# " title is left out unless `withTitle`.
 */
export function legalHtml(md: string, top: 2 | 3 = 2, withTitle = false): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) flush();
    else if (line.startsWith('### ')) {
      flush();
      out.push(`<h${top + 1}>${inline(line.slice(4))}</h${top + 1}>`);
    } else if (line.startsWith('## ')) {
      flush();
      out.push(`<h${top} id="${slug(line.slice(3))}">${inline(line.slice(3))}</h${top}>`);
    } else if (line.startsWith('# ')) {
      flush();
      if (withTitle) out.push(`<h${top - 1}>${inline(line.slice(2))}</h${top - 1}>`);
    } else if (line.startsWith('- ')) {
      if (para.length) flush();
      list.push(line.slice(2));
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join('\n');
}
