"use client";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { FAQS } from "@/config/faqs";

export default function FaqList() {
  return (
    <div className="space-y-2">
      {FAQS.map((f) => (
        <Collapsible
          key={f.q}
          className="rounded-xl border border-border-subtle bg-glass-2 px-4 py-3">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 text-sm font-medium text-primary">
            {f.q}
            <ChevronDown className="h-4 w-4 shrink-0 text-secondary transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 text-xs leading-relaxed text-secondary">
            {f.a}
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}
