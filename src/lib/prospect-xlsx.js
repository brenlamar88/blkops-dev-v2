import { mapMasterRows } from './prospect-review.js'
// Only MASTER and its shared strings are read. No macros, formulas or external links execute.
async function zipPart(buffer, path) {
  const view = new DataView(buffer),
    bytes = new Uint8Array(buffer),
    decoder = new TextDecoder()
  if (bytes.length < 22) throw Error('This is not a supported Excel workbook.')
  const lower = Math.max(0, bytes.length - 65557)
  let end = bytes.length - 22
  for (; end >= lower; end--)
    if (view.getUint32(end, true) === 0x06054b50) break
  if (end < lower) throw Error('This is not a supported Excel workbook.')
  let pos = view.getUint32(end + 16, true),
    count = view.getUint16(end + 10, true)
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50)
      throw Error('Workbook archive is damaged.')
    const method = view.getUint16(pos + 10, true),
      size = view.getUint32(pos + 20, true),
      expanded = view.getUint32(pos + 24, true),
      nameSize = view.getUint16(pos + 28, true),
      extra = view.getUint16(pos + 30, true),
      comment = view.getUint16(pos + 32, true),
      offset = view.getUint32(pos + 42, true)
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameSize))
    if (name === path) {
      if (expanded > 32 * 1024 * 1024)
        throw Error('Workbook section is too large (32 MB maximum).')
      if (view.getUint16(pos + 8, true) & 1)
        throw Error('Password-protected workbooks are not supported.')
      if (
        offset + 30 > bytes.length ||
        view.getUint32(offset, true) !== 0x04034b50
      )
        throw Error('Workbook archive is damaged.')
      const start =
        offset +
        30 +
        view.getUint16(offset + 26, true) +
        view.getUint16(offset + 28, true)
      if (start + size > bytes.length)
        throw Error('Workbook archive is incomplete.')
      let result = bytes.slice(start, start + size)
      if (method === 8) {
        let unzip
        try {
          unzip = new DecompressionStream('deflate-raw')
        } catch {
          throw Error(
            'Update your browser to read Excel files, or use a prospectus review JSON package.',
          )
        }
        const reader = new Blob([result])
            .stream()
            .pipeThrough(unzip)
            .getReader(),
          chunks = []
        let length = 0
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          length += value.length
          if (length > 32 * 1024 * 1024) {
            await reader.cancel()
            throw Error('Workbook section is too large.')
          }
          chunks.push(value)
        }
        result = new Uint8Array(length)
        let at = 0
        for (const chunk of chunks) {
          result.set(chunk, at)
          at += chunk.length
        }
      } else if (method !== 0)
        throw Error('Workbook compression is not supported.')
      if (result.length !== expanded)
        throw Error('Workbook section is incomplete.')
      return decoder.decode(result)
    }
    pos += 46 + nameSize + extra + comment
  }
  return null
}
function xml(source) {
  if (!source || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw Error('Unsupported workbook XML.')
  const doc = new DOMParser().parseFromString(source, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length)
    throw Error('Workbook XML could not be read.')
  return doc
}
const elements = (node, name) =>
  Array.from(node.getElementsByTagNameNS('*', name))
const textValue = (node) =>
  elements(node, 't')
    .map((t) => t.textContent)
    .join('')
export async function readProspectusFile(file) {
  if (file.size > 25 * 1024 * 1024)
    throw Error('Choose a workbook smaller than 25 MB.')
  if (file.name.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(await file.text())
    if (
      data.format !== 'blackops-prospectus-v1' ||
      !Array.isArray(data.rows) ||
      data.rows.length > 15000 ||
      !/^[a-f0-9]{64}$/.test(data.fingerprint)
    )
      throw Error('Choose a Black Ops prospectus review package.')
    return data
  }
  if (!/\.xlsx$/i.test(file.name))
    throw Error('Choose an .xlsx prospectus or a review .json package.')
  const buffer = await file.arrayBuffer(),
    workbook = xml(await zipPart(buffer, 'xl/workbook.xml')),
    rel = xml(await zipPart(buffer, 'xl/_rels/workbook.xml.rels'))
  const master = elements(workbook, 'sheet').find(
    (s) => s.getAttribute('name')?.trim().toUpperCase() === 'MASTER',
  )
  if (!master)
    throw Error(
      'No MASTER worksheet was found. Category tabs are not appended.',
    )
  const id = master.getAttribute('r:id'),
    target = elements(rel, 'Relationship')
      .find(
        (r) =>
          r.getAttribute('Id') === id &&
          r.getAttribute('TargetMode') !== 'External',
      )
      ?.getAttribute('Target')
  if (!target || target.includes('..') || target.includes(':'))
    throw Error('Unsupported MASTER worksheet path.')
  const path = target.startsWith('/')
    ? target.slice(1)
    : 'xl/' + target.replace(/^xl\//, '')
  const strings = await zipPart(buffer, 'xl/sharedStrings.xml'),
    shared = strings ? elements(xml(strings), 'si').map(textValue) : []
  const sheet = xml(await zipPart(buffer, path))
  const values = elements(sheet, 'row').map((row) => {
    const cells = []
    for (const c of elements(row, 'c')) {
      const letters = (c.getAttribute('r') || '').replace(/[0-9]/g, '')
      let index = 0
      for (const letter of letters)
        index = index * 26 + letter.charCodeAt(0) - 64
      if (!index || index > 100) continue
      const type = c.getAttribute('t'),
        value = elements(c, 'v')[0]?.textContent || ''
      cells[index - 1] =
        type === 's'
          ? (shared[Number(value)] ?? '')
          : type === 'inlineStr'
            ? textValue(c)
            : value
    }
    return { number: Number(row.getAttribute('r')), cells }
  })
  const fingerprint = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('')
  const rows = mapMasterRows(values, file.name)
  if (!rows.length || rows.length > 15000)
    throw Error('MASTER must contain between 1 and 15,000 records.')
  return {
    format: 'blackops-prospectus-v1',
    source_name: file.name,
    fingerprint,
    rows,
  }
}

export async function readBudgetFile(file) {
  if (file.size > 25 * 1024 * 1024)
    throw Error('Choose a budget smaller than 25 MB.')
  if (/\.json$/i.test(file.name)) {
    const data = JSON.parse(await file.text())
    if (data.format !== 'blackops-budget-v1' || !Array.isArray(data.sheets))
      throw Error('Choose a Black Ops budget review package.')
    return data
  }
  if (!/\.xlsx$/i.test(file.name))
    throw Error('Choose an Excel budget (.xlsx).')
  const buffer = await file.arrayBuffer(),
    workbook = xml(await zipPart(buffer, 'xl/workbook.xml')),
    rel = xml(await zipPart(buffer, 'xl/_rels/workbook.xml.rels'))
  const strings = await zipPart(buffer, 'xl/sharedStrings.xml'),
    shared = strings ? elements(xml(strings), 'si').map(textValue) : []
  const sheets = []
  for (const s of elements(workbook, 'sheet').filter((s) =>
    /KPI/i.test(s.getAttribute('name')),
  )) {
    const name = s.getAttribute('name'),
      target = elements(rel, 'Relationship')
        .find(
          (r) =>
            r.getAttribute('Id') === s.getAttribute('r:id') &&
            r.getAttribute('TargetMode') !== 'External',
        )
        ?.getAttribute('Target')
    if (!target || target.includes('..') || target.includes(':')) continue
    const doc = xml(
        await zipPart(
          buffer,
          target.startsWith('/')
            ? target.slice(1)
            : 'xl/' + target.replace(/^xl\//, ''),
        ),
      ),
      rows = []
    let months = []
    for (const row of elements(doc, 'row')) {
      const cells = {}
      for (const c of elements(row, 'c')) {
        const raw = elements(c, 'v')[0]?.textContent || '',
          type = c.getAttribute('t')
        cells[(c.getAttribute('r') || '').replace(/\d/g, '')] =
          type === 's'
            ? (shared[Number(raw)] ?? '')
            : type === 'inlineStr'
              ? textValue(c)
              : raw
      }
      const headings = Object.entries(cells)
        .map(([col, value]) => {
          const m = String(value).match(
            /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s-]*(\d{2}|\d{4})$/i,
          )
          return m
            ? {
                col,
                date:
                  (m[2].length === 2 ? '20' + m[2] : m[2]) +
                  '-' +
                  String(
                    [
                      'jan',
                      'feb',
                      'mar',
                      'apr',
                      'may',
                      'jun',
                      'jul',
                      'aug',
                      'sep',
                      'oct',
                      'nov',
                      'dec',
                    ].indexOf(m[1].toLowerCase()) + 1,
                  ).padStart(2, '0') +
                  '-01',
              }
            : null
        })
        .filter(Boolean)
      if (headings.length === 12) months = headings
      const label = String(cells.C || '')
          .trim()
          .toLowerCase(),
        metric =
          label === 'referrals goals'
            ? 'referrals'
            : label === 'admits'
              ? 'admissions'
              : label === 'adc'
                ? 'adc'
                : null
      if (metric && months.length === 12)
        for (const m of months) {
          const value = Number(cells[m.col])
          rows.push({
            metric,
            period_start: m.date,
            target:
              cells[m.col] !== '' && Number.isFinite(value) && value >= 0
                ? value
                : null,
            cell: m.col + row.getAttribute('r'),
            source_value: cells[m.col],
          })
        }
    }
    if (rows.length) sheets.push({ name, rows })
  }
  if (!sheets.length)
    throw Error(
      'No monthly Service Development referral/admission/ADC rows were found in KPI worksheets.',
    )
  return { format: 'blackops-budget-v1', source_name: file.name, sheets }
}
