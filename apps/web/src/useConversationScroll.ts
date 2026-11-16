/* eslint-disable react-hooks/set-state-in-effect -- new messages update the jump-to-latest affordance */
import { useLayoutEffect, useRef, useState } from "react";

export function useConversationScroll(messageKey: string, conversationKey: string | null) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatest = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    followLatest.current = true;
    setShowJump(false);
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationKey]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (followLatest.current) {
      element.scrollTop = element.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [messageKey]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const content = element?.firstElementChild;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationKey]);

  function onScroll(): void {
    const element = scrollRef.current;
    if (!element) return;
    const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
    followLatest.current = atLatest;
    if (atLatest) setShowJump(false);
  }

  function jumpToLatest(): void {
    followLatest.current = true;
    const element = scrollRef.current;
    if (!element) return;
    setShowJump(false);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }

  return { scrollRef, showJump, onScroll, jumpToLatest };
}
