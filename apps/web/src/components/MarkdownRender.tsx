import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const PLUGINS = [remarkGfm, remarkBreaks];

// Links from an agent open in a new tab; raw HTML in the text is never rendered (react-markdown
// escapes it) and unsafe URLs (javascript:) are dropped.
const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

/** Loaded on first use (see Markdown.tsx): the Markdown parser is a large part of the bundle. */
export default function MarkdownRender({ text, className }: { text: string; className: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
