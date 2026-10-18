// Squarified treemap layout (Bruls, Huizing, van Wijk). Pure: values in, rectangles out, in the
// same units as the given width/height. Tile area is exactly proportional to the value.

export interface TreemapRect<T> { item: T; x: number; y: number; w: number; h: number; }

export function squarify<T>(items: T[], valueOf: (t: T) => number, width: number, height: number): TreemapRect<T>[] {
  const data = items.map((item) => ({ item, v: Math.max(0, valueOf(item)) })).filter((d) => d.v > 0).sort((a, b) => b.v - a.v);
  const total = data.reduce((s, d) => s + d.v, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const nodes = data.map((d) => ({ item: d.item, a: d.v * scale }));
  const out: TreemapRect<T>[] = [];
  let x = 0, y = 0, w = width, h = height;

  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row), min = Math.min(...row);
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };

  let i = 0;
  while (i < nodes.length) {
    const side = Math.min(w, h);
    const row = [nodes[i]];
    let j = i + 1;
    while (j < nodes.length && worst([...row, nodes[j]].map((n) => n.a), side) <= worst(row.map((n) => n.a), side)) {
      row.push(nodes[j]);
      j++;
    }
    const sum = row.reduce((s, n) => s + n.a, 0);
    if (w >= h) {
      // column on the left
      const cw = sum / h;
      let cy = y;
      for (const n of row) { const nh = n.a / cw; out.push({ item: n.item, x, y: cy, w: cw, h: nh }); cy += nh; }
      x += cw; w -= cw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (const n of row) { const nw = n.a / rh; out.push({ item: n.item, x: cx, y, w: nw, h: rh }); cx += nw; }
      y += rh; h -= rh;
    }
    i = j;
  }
  return out;
}
