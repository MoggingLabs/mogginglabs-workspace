/** Grid templates: pane count -> grid dimensions. All are exact grids (rows*cols === count). */
export interface GridSpec {
  rows: number
  cols: number
}

export const TEMPLATES: Record<number, GridSpec> = {
  1: { rows: 1, cols: 1 },
  2: { rows: 1, cols: 2 },
  4: { rows: 2, cols: 2 },
  6: { rows: 2, cols: 3 },
  8: { rows: 2, cols: 4 },
  9: { rows: 3, cols: 3 },
  12: { rows: 3, cols: 4 },
  16: { rows: 4, cols: 4 }
}

/** Offered in the layout toolbar, in order. */
export const TEMPLATE_COUNTS = [1, 2, 4, 6, 8, 9, 12, 16]
