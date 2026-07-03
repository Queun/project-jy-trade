import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils.js";

const toneClass = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-emerald-100 text-emerald-800",
  warn: "bg-amber-100 text-amber-800",
  bad: "bg-rose-100 text-rose-800",
  info: "bg-sky-100 text-sky-800",
};

export function Badge({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof toneClass }) {
  return <span className={cn("inline-flex rounded px-2 py-1 text-xs font-medium", toneClass[tone], className)} {...props} />;
}
