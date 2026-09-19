"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyTextButton({
  text,
  label,
  copiedLabel = "コピーしました",
  className,
}: {
  text: string;
  label: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button className={cn(className)} onClick={handleCopy} type="button" variant="secondary">
      {copied ? copiedLabel : label}
    </Button>
  );
}
