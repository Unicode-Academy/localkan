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
