// biome-ignore-all lint/security/noDangerouslySetInnerHtml: This file renders checked-in, trusted parity markup rather than user content.
import cockpitMarkup from "~/legacy/cockpit.html?raw";

/**
 * The Cockpit is a deliberately isolated parity island: its approved demo
 * markup stays byte-for-byte compatible while React owns the route, section,
 * lifecycle and interaction bootstrap around it.
 */
export function ProductSection() {
  return (
    <section
      className="section v3-product-section"
      id="product"
      dangerouslySetInnerHTML={{ __html: cockpitMarkup }}
    />
  );
}
