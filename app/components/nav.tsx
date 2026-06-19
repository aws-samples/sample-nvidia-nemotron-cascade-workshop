"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Demo" },
  { href: "/bulk", label: "Bulk" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-6 px-6 md:px-10 pt-5 pb-0">
      {TABS.map((tab) => {
        const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`relative pb-2 text-sm font-medium transition-colors ${
              active
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {tab.label}
            {active && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-[var(--nano-green)]" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
