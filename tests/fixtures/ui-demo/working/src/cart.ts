export type CartItem = {
  sku: string;
  unitPriceCents: number;
  quantity: number;
};

export function subtotalCents(items: readonly CartItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
}

export function discountCents(items: readonly CartItem[]): number {
  const eligibleSubtotalCents = items.reduce(
    (sum, item) => item.quantity >= 3 ? sum + item.unitPriceCents * item.quantity : sum,
    0,
  );
  return Math.round(eligibleSubtotalCents * 0.1);
}

export function totalCents(items: readonly CartItem[]): number {
  return subtotalCents(items) - discountCents(items);
}
