import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-2xl border border-[#d7e2ef] bg-white px-3 text-sm outline-none placeholder:text-[#8aa0b8] focus:border-[#2563eb]",
        className,
      )}
      {...props}
    />
  );
}
