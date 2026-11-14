export const FREE_SHIPPING_CENTS = 15000
export const FLAT_SHIPPING_CENTS = 1200

const wholeDollarFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

const centFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatCents(cents: number): string {
  const dollars = cents / 100
  return Number.isInteger(dollars)
    ? wholeDollarFormatter.format(dollars)
    : centFormatter.format(dollars)
}
