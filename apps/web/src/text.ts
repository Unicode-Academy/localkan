/** A short card title from what was said: the first sentence, cut at a word boundary. */
export function deriveTitle(text: string, max = 70): string {
  const first = text.trim().split('\n')[0].trim();
  const sentence = first.split(/(?<=[.!?…])\s/)[0].replace(/[.!?…:]+$/, '').trim() || first;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '')}…`;
}

/** Text a patch adds to one file: the whole file when the file is new (the answer of an "ask"
 *  card, the plan of a planning card). */
export function addedText(patch: string, path: string): string | null {
  const chunk = patch.split(/^diff --git /m).find((c) => c.includes(` b/${path}`) || c.startsWith(`a/${path} `));
  if (!chunk) return null;
  const lines = chunk
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  return lines.length ? lines.join('\n') : null;
}

/** "15:00", or "09:00 16/11" when not today. */
export function clockLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${time} ${at.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`;
}

/** Inline choices like "… (A) one thing. (B) another. (C) other." (or "A) … B) …"), as a
 *  Markdown list under the question, so each choice gets its own line. Text that already has
 *  lines, or fewer than two choices in order, is left as it is. */
export function listChoices(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const marks = [...line.matchAll(/(?:^|\s)\(?([A-H]|[1-9])\)\s/g)];
    // Choices must run A, B, C… (or 1, 2, 3…) from the first one.
    const run: RegExpMatchArray[] = [];
    for (const m of marks) {
      const expected = run.length === 0 ? (/\d/.test(m[1]) ? '1' : 'A') : String.fromCharCode(run[run.length - 1][1].charCodeAt(0) + 1);
      if (m[1] === expected) run.push(m);
      else if (run.length < 2) {
        run.length = 0;
        if (m[1] === 'A' || m[1] === '1') run.push(m);
      }
    }
    if (run.length < 2) {
      out.push(line);
      continue;
    }
    const start = (m: RegExpMatchArray) => m.index! + (m[0].startsWith(' ') || m[0].startsWith('\t') ? 1 : 0);
    const intro = line.slice(0, start(run[0])).trim();
    if (intro) out.push(intro, '');
    run.forEach((m, i) => {
      const from = start(m) + m[0].trimStart().length;
      const to = i + 1 < run.length ? start(run[i + 1]) : line.length;
      out.push(`- **${m[1]}.** ${line.slice(from, to).trim()}`);
    });
    out.push('');
  }
  return out.join('\n').trim();
}

/** The bridge appends "Lựa chọn: a, b" to questions that come with options. */
export function splitOptions(text: string): { question: string; options: string[] } {
  const m = text.match(/\n?Lựa chọn: (.+)$/);
  if (!m) return { question: text, options: [] };
  const options = m[1]
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .slice(0, 6);
  return { question: text.slice(0, m.index).trim(), options };
}

/** Markdown reduced to plain text, for one-line previews. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
