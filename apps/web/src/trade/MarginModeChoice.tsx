// Cross or isolated margin for a new trade, shared by Home and the Pro ticket. The choice is saved per device.
import { InfoTip, Segmented } from "../ui/primitives.js";
import { usePrefs, type MarginMode } from "../ui/prefs.js";

const LABELS: Record<MarginMode, string> = { cross: "Cross", isolated: "Isolated" };

/**
 * `crossOnly` (limit and stop orders, which rest on the main account) shows Cross as the only choice without
 * changing the saved one.
 */
export function MarginModeChoice({ crossOnly = false }: { crossOnly?: boolean }) {
  const { marginMode, setMarginMode } = usePrefs();
  return (
    <div className="margin-mode">
      <span className="callout rfq-muted">
        Margin
        <InfoTip label="About cross and isolated margin">
          Cross: the trade shares your whole balance with your other positions, and each market holds one
          position. It is harder to liquidate, but a loss can use your whole balance. Isolated: the trade's
          margin is set aside on its own, so that margin is the most it can lose.
          {crossOnly && " Limit and stop orders always use cross."}
        </InfoTip>
      </span>
      <Segmented
        label="Margin mode"
        value={crossOnly ? "cross" : marginMode}
        onChange={setMarginMode}
        options={(["cross", "isolated"] as const).map((id) => ({
          id,
          label: LABELS[id],
          disabled: crossOnly && id === "isolated",
        }))}
      />
    </div>
  );
}

/** The margin mode a new trade uses: isolated only when chosen and the order can be isolated. */
export function useMarginMode(crossOnly = false): MarginMode {
  const { marginMode } = usePrefs();
  return crossOnly ? "cross" : marginMode;
}
