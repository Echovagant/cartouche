/**
 * 标注避让的纯布局计算。
 *
 * 屏幕上的标注原来用「与已放下的每个框逐个比较」：最多 600 条时是
 * 十几万次矩形比较，而且每一帧重来一遍。这里换成**网格索引**：
 * 每个框只和它覆盖到的格子里的框比较，密集画面也不会退化成平方级。
 *
 * 纯函数、不碰 DOM：单测可以直接喂几千个框验证避让与耗时。
 */

/** 一个已换算到屏幕像素的标注外框 */
export interface LabelBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** 网格格子边长（像素）：比常见标注框略大，一个框通常只落 1~4 格 */
const CELL_SIZE = 64;

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/**
 * 按输入顺序放置标注框，返回每条是否放得下。
 *
 * 先到先得：调用方把优先级高的标注排在前面（上层图层优先）。
 * 与已放下的框重叠的返回 false，调用方据此跳过绘制。
 */
export function placeLabelBoxes(boxes: readonly LabelBox[]): boolean[] {
  const accepted = new Array<boolean>(boxes.length);
  const grid = new Map<string, LabelBox[]>();

  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i]!;
    // 退化框（宽或高为 0）不参与避让，也不占格子
    if (!(box.x2 > box.x1) || !(box.y2 > box.y1)) {
      accepted[i] = true;
      continue;
    }
    const cx0 = Math.floor(box.x1 / CELL_SIZE);
    const cx1 = Math.floor(box.x2 / CELL_SIZE);
    const cy0 = Math.floor(box.y1 / CELL_SIZE);
    const cy1 = Math.floor(box.y2 / CELL_SIZE);

    let collide = false;
    search: for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        const cell = grid.get(`${cx},${cy}`);
        if (!cell) continue;
        for (const placed of cell) {
          if (overlaps(box, placed)) {
            collide = true;
            break search;
          }
        }
      }
    }
    if (collide) {
      accepted[i] = false;
      continue;
    }

    accepted[i] = true;
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        const key = `${cx},${cy}`;
        const cell = grid.get(key);
        if (cell) cell.push(box);
        else grid.set(key, [box]);
      }
    }
  }
  return accepted;
}
