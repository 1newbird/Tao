import { isValidElement, memo, useMemo } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.css";

interface MarkdownContentProps {
  content: string;
  messageId: string;
  copiedKey?: string;
  onCopy: (text: string, key: string) => void;
  variant?: "chat" | "workspace";
}

export function safeMarkdownHref(value: string) {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

/** Shared parser for persisted messages, streaming replies and file previews. */
export const MarkdownContent = memo(function MarkdownContent({ content, messageId, copiedKey, onCopy, variant = "chat" }: MarkdownContentProps) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const safe = href && safeMarkdownHref(href);
      return safe ? <a href={safe} target={safe.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{children}</a> : <span>{children}</span>;
    },
    img: ({ alt, src }) => <span className="workspace-md-image-placeholder"><span>图片</span><code>{alt || src || "图片引用"}</code></span>,
    code: ({ children, className }) => <code className={className ?? "inline-code"}>{children}</code>,
    pre: ({ children, node }) => {
      const child = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children : null;
      const code = String(child?.props.children ?? "").replace(/\n$/, "");
      const language = child?.props.className?.replace(/^language-/, "") ?? "code";
      const key = `${messageId}-code-${node?.position?.start.offset ?? 0}`;
      return <div className="markdown-code-block">
        <div className="markdown-code-header"><span>{language}</span><button type="button" onClick={() => onCopy(code, key)}>{copiedKey === key ? "已复制" : "复制代码"}</button></div>
        <pre><code className={child?.props.className}>{code}</code></pre>
      </div>;
    },
    table: ({ children }) => <div className="markdown-table-wrap" role="region" aria-label="Markdown 表格" tabIndex={0}><table>{children}</table></div>,
  }), [messageId, copiedKey, onCopy]);
  return <div className={variant === "workspace" ? "markdown-content workspace-markdown-preview" : "markdown-content"}>
    <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml urlTransform={(value) => safeMarkdownHref(value) ?? ""}>{content}</Markdown>
  </div>;
});
