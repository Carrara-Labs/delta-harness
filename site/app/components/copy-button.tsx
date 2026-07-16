import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";

type CopyState = "idle" | "copied" | "failed";

async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to a selection-based copy for older or restricted browsers.
    }
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Copy failed");
}

export function CopyButton({
  text,
  label,
  className = "copy-button",
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const visibleLabel = state === "copied" ? "Copied" : state === "failed" ? "Select" : "Copy";
  const ariaLabel =
    state === "copied"
      ? "Copied"
      : state === "failed"
        ? "Copy failed. Select the text manually."
        : label;

  return (
    <Button
      className={className}
      type="button"
      variant="ghost"
      aria-label={ariaLabel}
      onClick={async () => {
        if (resetTimer.current) clearTimeout(resetTimer.current);
        try {
          await copyText(text);
          setState("copied");
          const liveRegion = document.getElementById("copy-status");
          if (liveRegion) liveRegion.textContent = `${label.replace(/^Copy /, "")} copied`;
        } catch {
          setState("failed");
          const liveRegion = document.getElementById("copy-status");
          if (liveRegion) liveRegion.textContent = "Copy failed. Select the text manually.";
        }
        resetTimer.current = setTimeout(() => setState("idle"), 1600);
      }}
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.5" stroke="currentColor" />
        <path
          d="M10.8 5.2V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.7c0 .7.6 1.3 1.3 1.3h1.4"
          stroke="currentColor"
        />
      </svg>
      <span className="copy-label" aria-live="polite">
        {visibleLabel}
      </span>
    </Button>
  );
}
