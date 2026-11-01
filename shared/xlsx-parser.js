const decoder = new TextDecoder('utf-8');

function findEndOfCentralDirectory(bytes) {
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (new DataView(bytes.buffer, bytes.byteOffset + i, 4).getUint32(0, true) === 0x06054b50) return i;
  }
  return -1;
}

async function unzipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const end = findEndOfCentralDirectory(bytes);
  if (end < 0) throw new Error('不是有效的 XLSX 文件');
  const total = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries = new Map();
  for (let i = 0; i < total; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('XLSX ZIP目录损坏');
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    let content = bytes.slice(dataStart, dataStart + compressedSize);
    if (method === 8) {
      const stream = new Blob([content]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      content = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (method !== 0) throw new Error(`不支持的XLSX压缩方式：${method}`);
    entries.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xml(bytes) {
  return new DOMParser().parseFromString(decoder.decode(bytes), 'application/xml');
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A';
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

export async function parseXlsx(file) {
  const entries = await unzipEntries(await file.arrayBuffer());
  const shared = [];
  const sharedBytes = entries.get('xl/sharedStrings.xml');
  if (sharedBytes) {
    for (const item of xml(sharedBytes).querySelectorAll('si')) shared.push([...item.querySelectorAll('t')].map((node) => node.textContent).join(''));
  }
  const sheetBytes = entries.get('xl/worksheets/sheet1.xml');
  if (!sheetBytes) throw new Error('工作簿中没有找到第一个工作表');
  const rows = [];
  for (const rowNode of xml(sheetBytes).querySelectorAll('sheetData > row')) {
    const row = [];
    for (const cell of rowNode.querySelectorAll('c')) {
      const index = columnIndex(cell.getAttribute('r') || 'A1');
      const type = cell.getAttribute('t');
      const value = cell.querySelector('v')?.textContent ?? '';
      if (type === 's') row[index] = shared[Number(value)] ?? '';
      else if (type === 'inlineStr') row[index] = [...cell.querySelectorAll('is t')].map((node) => node.textContent).join('');
      else row[index] = value;
    }
    rows.push(row);
  }
  return rows;
}

