import { discountCents, totalCents, type CartItem } from "./cart";

export type CheckoutSummary = {
  itemCount: number;
  discountCents: number;
  totalCents: number;
};

export function summarizeCheckout(items: readonly CartItem[]): CheckoutSummary {
  return {
    itemCount: items.reduce((count, item) => count + item.quantity, 0),
    discountCents: discountCents(items),
    totalCents: totalCents(items),
  };
}
