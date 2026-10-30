const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '../..');
const work = __dirname;
const sourceDirectory = path.join(root, 'artwork/inkbound');
const output = path.join(root, 'frontend/public/pets');
const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(sourceDirectory, { recursive: true });
fs.mkdirSync(output, { recursive: true });
console.log('$ node ' + __filename);

function components(image) {
  const { width, height, data } = image;
  const seen = new Uint8Array(width * height), queue = new Int32Array(seen.length), found = [];
  for (let seed = 0; seed < seen.length; seed++) {
    if (seen[seed] || data[seed * 4 + 3] < 32) continue;
    let read = 0, write = 1, x0 = width, y0 = height, x1 = 0, y1 = 0;
    queue[0] = seed; seen[seed] = 1;
    while (read < write) {
      const at = queue[read++], x = at % width, y = Math.floor(at / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const next of [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y ? at - width : -1, y + 1 < height ? at + width : -1]) {
        if (next < 0 || seen[next] || data[next * 4 + 3] < 32) continue;
        seen[next] = 1; queue[write++] = next;
      }
    }
    found.push({ area: write, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }
  return found;
}

function rectDistance(a, b) {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1), dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return dx * dx + dy * dy;
}

function readFrames(file, expectedRows) {
  const image = PNG.sync.read(fs.readFileSync(file));
  const all = components(image), main = all.filter(part => part.area >= 2000).sort((a, b) => a.cy - b.cy);
  const groups = [];
  const gap = expectedRows === 4 ? image.height / 8 : 42;
  for (const part of main) {
    let group = groups.at(-1);
    if (!group || part.cy - group.at(-1).cy > gap) groups.push(group = []);
    group.push(part);
  }
  if (groups.length !== expectedRows) throw Error(`${file}: expected ${expectedRows} rows, found ${groups.length}: ${groups.map(row => row.length)}`);
  for (const group of groups) group.sort((a, b) => a.cx - b.cx);
  for (const part of main) part.bounds = { ...part };
  for (const part of all) {
    if (main.includes(part) || part.area < 6) continue;
    const closest = main.reduce((best, candidate) => rectDistance(part, candidate) < rectDistance(part, best) ? candidate : best);
    if (rectDistance(part, closest) > 18 * 18) continue;
    const b = closest.bounds;
    b.x0 = Math.min(b.x0, part.x0); b.y0 = Math.min(b.y0, part.y0); b.x1 = Math.max(b.x1, part.x1); b.y1 = Math.max(b.y1, part.y1);
  }
  for (const part of main) {
    const b = part.bounds;
    b.x0 = Math.max(0, b.x0 - 4); b.y0 = Math.max(0, b.y0 - 4);
    b.x1 = Math.min(image.width - 1, b.x1 + 4); b.y1 = Math.min(image.height - 1, b.y1 + 4);
    part.width = b.x1 - b.x0 + 1; part.height = b.y1 - b.y0 + 1;
  }
  const owners = new Int16Array(image.width * image.height).fill(-1);
  const distances = new Float64Array(owners.length).fill(Infinity);
  for (let index = 0; index < main.length; index++) {
    const part = main[index], b = part.bounds; part.index = index;
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
      const dx = Math.max(0, part.x0 - x, x - part.x1), dy = Math.max(0, part.y0 - y, y - part.y1);
      const distance = dx * dx + dy * dy + 0.00001 * ((x - part.cx) ** 2 + (y - part.cy) ** 2), at = y * image.width + x;
      if (distance < distances[at]) { distances[at] = distance; owners[at] = index; }
    }
  }
  return { image, main, groups, owners };
}

function drawFrame(destination, source, part, scale, column, row, lift = 0) {
  const b = part.bounds, width = Math.round(part.width * scale), height = Math.round(part.height * scale);
  const left = column * 192 + Math.round((192 - width) / 2), top = row * 208 + 194 - height - lift;
  if (left < column * 192 + 6 || left + width > (column + 1) * 192 - 6 || top < row * 208 + 5 || top + height > (row + 1) * 208 - 6) throw Error(`Frame overflow at ${row}:${column}`);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = b.x0 + (x + 0.5) / scale - 0.5, sy = b.y0 + (y + 0.5) / scale - 0.5;
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
    let alpha = 0, red = 0, green = 0, blue = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const px = ix + dx, py = iy + dy;
      if (px < b.x0 || px > b.x1 || py < b.y0 || py > b.y1) continue;
      if (source.owners[py * source.image.width + px] !== part.index) continue;
      const i = (py * source.image.width + px) * 4, data = source.image.data;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), a = data[i + 3] * weight;
      alpha += a; red += data[i] * a; green += data[i + 1] * a; blue += data[i + 2] * a;
    }
    if (!alpha) continue;
    const target = ((top + y) * destination.width + left + x) * 4;
    destination.data[target] = Math.round(red / alpha); destination.data[target + 1] = Math.round(green / alpha);
    destination.data[target + 2] = Math.round(blue / alpha); destination.data[target + 3] = Math.round(alpha);
  }
  return { row, column, source: { x: b.x0, y: b.y0, width: part.width, height: part.height }, scale, lift };
}

const prompts = JSON.parse(fs.readFileSync(path.join(work, 'prompts.json')));
const assets = prompts.map(item => ({ id: item.id, source: path.join(work, item.id + '-motions.png'), prompt: item.motion, transparencyPrompt: item.transparency }));
const gazeAssets = prompts.map(item => ({ id: item.id, source: path.join(work, item.id + '-gaze.png'), prompt: item.gaze }));
const records = [];
for (const asset of assets) {
  const gazeAsset = gazeAssets.find(item => item.id === asset.id);
  if (!gazeAsset?.source) throw Error(`Missing gaze artwork: ${asset.id}`);
  const sourcePath = path.join(sourceDirectory, `${asset.id}-motions.png`), gazePath = path.join(sourceDirectory, `${asset.id}-gaze.png`);
  if (asset.source !== sourcePath) fs.copyFileSync(asset.source, sourcePath);
  if (gazeAsset.source !== gazePath) fs.copyFileSync(gazeAsset.source, gazePath);
  const source = readFrames(sourcePath, 11), gaze = readFrames(gazePath, 4);
  console.log(`${asset.id}: source ${source.image.width}x${source.image.height}; rows ${source.groups.map(group => group.length)}; gaze ${gaze.groups.map(group => group.length)}`);
  const selected = source.groups.slice(0, 9).map((group, row) => {
    if (row === 4 && group.length === 6) return [group[0], group[1], group[2], group[3], group[5]];
    if (group.length < counts[row]) throw Error(`Missing motion frames ${asset.id}:${row}`);
    return group.slice(0, counts[row]);
  });
  const motionFrames = selected.flat(), scale = Math.min(170 / Math.max(...motionFrames.map(p => p.width)), 174 / Math.max(...motionFrames.map(p => p.height)));
  const idleHeights = selected[0].map(p => p.height * scale).sort((a, b) => a - b);
  const gazeFrames = gaze.groups.flat();
  if (gazeFrames.length !== 16 || gaze.groups.some(group => group.length !== 4)) throw Error(`Expected sixteen gaze poses: ${asset.id}`);
  const gazeScale = Math.min(idleHeights[3] / (gazeFrames.reduce((sum, p) => sum + p.height, 0) / 16), 174 / Math.max(...gazeFrames.map(p => p.height)), 170 / Math.max(...gazeFrames.map(p => p.width)));
  const sheet = new PNG({ width: 1536, height: 2288 }), placements = [];
  for (let row = 0; row < 9; row++) for (let column = 0; column < counts[row]; column++) {
    const part = selected[row][column];
    const jump = [0, 10, 26, 3, 0][column] || 0;
    const lift = row === 4 ? Math.min(jump, Math.max(0, 185 - Math.round(part.height * scale))) : 0;
    placements.push(drawFrame(sheet, source, part, scale, column, row, lift));
  }
  for (let direction = 0; direction < 16; direction++) placements.push(drawFrame(sheet, gaze, gazeFrames[direction], gazeScale, direction % 8, 9 + Math.floor(direction / 8)));
  const pngFile = path.join(output, asset.id + '.png'), webpFile = path.join(output, asset.id + '.webp');
  fs.writeFileSync(pngFile, PNG.sync.write(sheet));
  const encoded = spawnSync('cwebp', ['-lossless', '-exact', '-quiet', pngFile, '-o', webpFile], { encoding: 'utf8' });
  if (encoded.status !== 0) throw Error(encoded.stderr || 'WebP encoder failed');
  const record = { id: asset.id, dimensions: [1536, 2288], cells: [192, 208], motionFrames: 57, gazeFrames: 16, sha256: hash(fs.readFileSync(webpFile)), sources: [{ file: path.basename(sourcePath), sha256: hash(fs.readFileSync(sourcePath)) }, { file: path.basename(gazePath), sha256: hash(fs.readFileSync(gazePath)) }], placements };
  fs.unlinkSync(pngFile);
  records.push(record);
  console.log(`${asset.id}: 57 motion frames + 16 gaze poses; transparent 1536x2288; WebP ${fs.statSync(webpFile).size} bytes; sha256 ${record.sha256}`);
}
fs.writeFileSync(path.join(sourceDirectory, 'atlas-manifest.json'), JSON.stringify({ collection: 'Inkbound', method: 'Original image generation; alpha-aware frame registration; lossless WebP encoding.', characters: records }, null, 2) + '\n');

console.log('Packed nine original companion atlases without changing the renderer animation contract.');
