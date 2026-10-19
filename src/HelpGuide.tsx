import guide from "../docs/项目手册/12-功能指南.md?raw";
import { useCallback, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";

const sections = guide.split(/\r?\n## /).slice(1).map((text) => ({ title: text.split(/\r?\n/, 1)[0], content: `## ${text}` }));
export function HelpGuide({ topic, onTopicChange }: { topic: number; onTopicChange: (value: number) => void }) {
  const [copiedKey, setCopiedKey] = useState("");
  const [copyError, setCopyError] = useState("");
  const copy = useCallback((text: string, key: string) => { void navigator.clipboard.writeText(text).then(() => setCopiedKey(key)).catch(() => setCopyError("复制失败，请手动选择文本")); }, []);
  return <section className="workspace-section help-guide"><div className="workspace-heading"><span className="eyebrow">使用说明</span><h2>帮助与功能指南</h2><p>了解当前能力、操作入口与适用边界。说明随应用一起打包，可离线查看。</p></div>
    <nav className="guide-topics" aria-label="功能指南主题">{sections.map((section, index) => <button type="button" className={topic === index ? "selected" : ""} key={section.title} onClick={() => onTopicChange(index)}>{section.title}</button>)}</nav>
    {copyError && <p role="status">{copyError}</p>}
    <MarkdownContent content={sections[topic]?.content ?? sections[0].content} messageId={`guide-${topic}`} onCopy={copy} copiedKey={copiedKey} />
  </section>;
}
