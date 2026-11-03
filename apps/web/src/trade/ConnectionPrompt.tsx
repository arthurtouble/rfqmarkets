// Asked for when a trading action (close, TP/SL, cancel, an order) is tapped before this browser is connected for
// trading. Connecting here carries on with the action that asked; closing it leaves everything as it was.
import { useTrading } from "../data/actions.js";
import { Sheet } from "../ui/primitives.js";
import { StartTrading } from "./StartTrading.js";

export function ConnectionPrompt() {
  const trading = useTrading();
  if (!trading.connectionPrompt) return null;
  return (
    <Sheet
      open
      onClose={trading.dismissConnectionPrompt}
      title="Establish connection"
      labelledBy="connection-prompt-title"
    >
      <div className="sheet-body">
        <p className="rfq-muted">
          Closing positions, TP/SL and every other trade action need a connection first. Connect once and this
          carries on where you left off.
        </p>
        <StartTrading label="Establish connection" />
      </div>
    </Sheet>
  );
}
