// The call grid (3+ people): how many columns give the biggest 16:9 tiles in the space available.
// CSS auto-fit can't see the height, so with 4 people it made one small row and left the rest empty.

/**
 * @param {number} count tiles to place
 * @param {number} width available width (px)
 * @param {number} height available height (px)
 * @param {number} gap space between tiles (px)
 * @returns {{ columns: number, tileWidth: number }}
 */
export function fitGrid(count, width, height, gap, ratio = 16 / 9) {
  let best = { columns: 1, tileWidth: 0 };
  for (let columns = 1; columns <= Math.max(1, count); columns++) {
    const rows = Math.ceil(count / columns);
    const byWidth = (width - gap * (columns - 1)) / columns;
    const byHeight = ((height - gap * (rows - 1)) / rows) * ratio;
    const tileWidth = Math.floor(Math.min(byWidth, byHeight));
    if (tileWidth > best.tileWidth) best = { columns, tileWidth };
  }
  return best;
}
