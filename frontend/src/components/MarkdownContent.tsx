import ReactMarkdown, { type Components } from "react-markdown";

import { safeHttpUrl } from "@/lib/format";

// Raw HTML is never rendered (react-markdown skips it without rehype-raw), and unsafe
// URL schemes are stripped by its default urlTransform. External links open safely.
const components: Components = {
  a: ({ href, children }) => {
    const url = href ? safeHttpUrl(href) : null;
    if (!url) return <span>{children}</span>;
    return (
      <a href={url.href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img: () => null,
};

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="answer-prose">
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  );
}
