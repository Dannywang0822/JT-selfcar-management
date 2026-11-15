import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full bg-[#f8edd6] px-2.5 py-1 text-xs font-medium text-[#8a5a20]", className)}>
      {children}
    </span>
  );
}
