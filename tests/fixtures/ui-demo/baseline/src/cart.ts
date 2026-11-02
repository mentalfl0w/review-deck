export type CartItem = {
  sku: string;
  unitPriceCents: number;
  quantity: number;
};

export function subtotalCents(items: readonly CartItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
}

export function discountCents(items: readonly CartItem[]): number {
  const subtotal = subtotalCents(items);
  return Math.floor(subtotal * 0.05);
}

export function totalCents(items: readonly CartItem[]): number {
  return subtotalCents(items) - discountCents(items);
}
