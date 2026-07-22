import { MenuIcon } from "lucide-react";
import { useRef } from "react";

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

const navigation = [
  {
    href: "/how-it-works",
    label: "How it works",
    description: "A visual crash course on the runtime",
  },
  { href: "#product", label: "Product", description: "Walk through the inspectable runtime" },
  { href: "#why-delta", label: "Why Delta", description: "Compare operating models" },
  {
    href: "#use-cases",
    label: "Use cases",
    description: "Assistants, features and shared runtime",
  },
  { href: "#build", label: "Build", description: "Create and run an agent" },
  { href: "#observe", label: "Operate", description: "Trace, deploy and recover" },
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
            <SheetClose asChild key={item.href}>
              <a
                href={item.href}
                target={item.external ? "_blank" : undefined}
                rel={item.external ? "noreferrer" : undefined}
                onClick={() => {
                  if (!item.href.startsWith("#")) return;
                  pendingSection.current = item.href;
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
