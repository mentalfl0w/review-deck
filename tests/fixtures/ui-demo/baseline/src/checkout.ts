import { totalCents, type CartItem } from "./cart";

export type CheckoutSummary = {
  itemCount: number;
  totalCents: number;
};

export function summarizeCheckout(items: readonly CartItem[]): CheckoutSummary {
  return {
    itemCount: items.reduce((count, item) => count + item.quantity, 0),
    totalCents: totalCents(items),
  };
}
