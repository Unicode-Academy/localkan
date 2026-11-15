import { lazy, Suspense } from 'react';

const Rendered = lazy(() => import('./MarkdownRender.tsx'));

/** Text an agent wrote (report, question, answer, plan), shown as formatted Markdown. Until the
 *  renderer has loaded, the raw text is shown with its line breaks. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const cls = className ? `md ${className}` : 'md';
  return (
    <Suspense fallback={<div className={`${cls} md-plain`}>{text}</div>}>
      <Rendered text={text} className={cls} />
    </Suspense>
  );
}
