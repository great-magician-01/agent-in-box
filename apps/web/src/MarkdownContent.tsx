import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(() =>
  import("./MarkdownRenderer").then((module) => ({ default: module.MarkdownRenderer })),
);

export function MarkdownContent({ content }: { content: string }) {
  return (
    <Suspense fallback={<p className="markdown-fallback">{content}</p>}>
      <MarkdownRenderer content={content} />
    </Suspense>
  );
}
