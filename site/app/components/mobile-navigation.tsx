import { MenuIcon } from "lucide-react";
import { useRef } from "react";
import { useLocation } from "react-router";

import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";

type NavItem = {
  label: string;
  description: string;
  section?: string;
  href?: string;
  external?: boolean;
};

const navigation: NavItem[] = [
  {
    href: "/how-it-works",
    label: "How it works",
    description: "A visual crash course on the runtime",
  },
  { section: "product", label: "Product", description: "Walk through the inspectable runtime" },
  { section: "why-delta", label: "Why Delta", description: "Compare operating models" },
  {
    section: "use-cases",
    label: "Use cases",
    description: "Assistants, features and shared runtime",
  },
  { section: "build", label: "Build", description: "Create and run an agent" },
  { section: "observe", label: "Operate", description: "Trace, deploy and recover" },
  { href: "/docs/", label: "Documentation", description: "Read the canonical technical guide" },
  {
    href: "https://github.com/Carrara-Labs/delta-harness",
    label: "GitHub",
    description: "Browse the open-source repository",
    external: true,
  },
];

export function MobileNavigation() {
  const pendingSection = useRef<string | null>(null);
  const onHome = useLocation().pathname === "/";
  // Section links are in-page anchors on home, but must jump back to home first from any other route.
  const hrefFor = (item: NavItem) =>
    item.section ? (onHome ? `#${item.section}` : `/#${item.section}`) : (item.href ?? "#");

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          className="mobile-menu-trigger"
          size="icon"
          type="button"
          variant="ghost"
          aria-label="Open navigation"
        >
          <MenuIcon aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent
        className="delta-mobile-sheet"
        aria-describedby="mobile-nav-description"
        onCloseAutoFocus={(event) => {
          const hash = pendingSection.current;
          if (!hash) return;

          event.preventDefault();
          pendingSection.current = null;
          const section = document.querySelector<HTMLElement>(hash);
          if (!section) return;

          if (window.location.hash !== hash) {
            window.history.pushState(null, "", hash);
          }
          section.scrollIntoView({ block: "start" });
          const heading = section.querySelector<HTMLElement>("h1, h2");
          if (heading) {
            heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
          }
        }}
      >
        <SheetHeader className="delta-mobile-sheet-header">
          <SheetTitle>Navigate Delta</SheetTitle>
          <SheetDescription id="mobile-nav-description">
            Product overview and technical documentation.
          </SheetDescription>
        </SheetHeader>
        <nav className="delta-mobile-nav" aria-label="Mobile navigation">
          {navigation.map((item) => (
            <SheetClose asChild key={item.section ?? item.href}>
              <a
                href={hrefFor(item)}
                target={item.external ? "_blank" : undefined}
                rel={item.external ? "noreferrer" : undefined}
                onClick={() => {
                  // Only smooth-scroll when the target section is on THIS page (home).
                  if (item.section && onHome) pendingSection.current = `#${item.section}`;
                }}
              >
                <strong>{item.label}</strong>
                <span>{item.description}</span>
              </a>
            </SheetClose>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
