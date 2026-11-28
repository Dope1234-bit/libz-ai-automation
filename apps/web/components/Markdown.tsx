"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders AI replies as Markdown. Raw HTML is never rendered (skipHtml), so a
 * reply cannot inject markup or scripts; links open safely in a new tab.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {label}
            </a>
          ),
          img: ({ alt }) => <span className="md-img-alt">[image: {alt ?? "image"}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
