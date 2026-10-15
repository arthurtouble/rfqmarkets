import { Link } from "@tanstack/react-router";
import type { Market } from "../lib/types.js";
import { EmptyState } from "../ui/primitives.js";

/** A symbol-shaped URL for a market that is not listed. */
export function UnknownMarket({ market }: { market: Market }) {
  return (
    <div className="page">
      <section className="rfq-card">
        <EmptyState
          mood="loss"
          action={
            <Link className="rfq-btn rfq-btn--primary" to="/markets">
              See all markets
            </Link>
          }
        >
          <b>{market}</b> isn't listed on RFQ Markets.
        </EmptyState>
      </section>
    </div>
  );
}
