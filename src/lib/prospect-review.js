// Comparisons suggest review; they never establish identity or change records.
export const clean = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
export const normalize = (value) =>
  clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
export const addressKey = (value) =>
  normalize(value).replace(
    /\b(STREET|ROAD|AVENUE|DRIVE|BOULEVARD|HIGHWAY|SUITE)\b/g,
    (x) =>
      ({
        STREET: 'ST',
        ROAD: 'RD',
        AVENUE: 'AVE',
        DRIVE: 'DR',
        BOULEVARD: 'BLVD',
        HIGHWAY: 'HWY',
        SUITE: 'STE',
      })[x],
  )
export const categoryKey = (value) =>
  normalize(value)
    .replace(/^HOSPITALS?$/, 'HOSPITALS')
    .replace(/^PRACTITIONERS?$/, 'PRACTITIONERS')
    .replace(/^ELDER CARE$/, 'ELDERCARE')
    .replace(/^MENTAL HEALTH SERVICES$/, 'MENTAL HEALTH')
    .replace(/^COMMUNITY RESOURCES$/, 'COMMUNITY')
export const phoneProblem = (value) => {
  const n = clean(value).replace(/\D/g, '')
  return !n
    ? 'Phone missing'
    : /^(\d)\1{5}/.test(n) || !/^(1)?[2-9]\d{2}[2-9]\d{6}$/.test(n)
      ? 'Phone may be a placeholder or invalid'
      : null
}
export function trigrams(value) {
  const n = '  ' + normalize(value) + ' '
  return new Set(
    Array.from({ length: Math.max(0, n.length - 2) }, (_, i) =>
      n.slice(i, i + 3),
    ),
  )
}
export function similarity(a, b) {
  const x = trigrams(a),
    y = trigrams(b)
  let shared = 0
  for (const t of x) if (y.has(t)) shared++
  return x.size + y.size ? (2 * shared) / (x.size + y.size) : 0
}
export function mapMasterRows(values, source) {
  const header = values.findIndex((r) =>
    r.cells.some((c) => normalize(c) === 'PROSPECT NAME'),
  )
  if (header < 0) throw Error('MASTER must contain a PROSPECT NAME header.')
  const columns = values[header].cells.map(normalize),
    col = (cells, key) => clean(cells[columns.indexOf(key)])
  return values
    .slice(header + 1)
    .filter((r) => r.cells.some((c) => clean(c)))
    .map((r) => ({
      source_name: source,
      sheet: 'MASTER',
      row_number: r.number,
      raw: Object.fromEntries(
        columns
          .filter(Boolean)
          .map((k) => [k, r.cells[columns.indexOf(k)] ?? '']),
      ),
      record: {
        name: col(r.cells, 'PROSPECT NAME'),
        address_line1: col(r.cells, 'PROSPECT ADDRESS'),
        city: col(r.cells, 'CITY'),
        state: col(r.cells, 'PROSPECT STATE'),
        zip: col(r.cells, 'PROSPECT ZIP'),
        phone: col(r.cells, 'PROSPECT PHONE'),
        fax: col(r.cells, 'PROSPECT FAX'),
        category: col(r.cells, 'CATEGORY'),
        prospect_type: col(r.cells, 'PROSPECT TYPE'),
        prospect_status: col(r.cells, 'PROSPECT STATUS'),
        territory: col(r.cells, 'TERRITORY'),
        air_miles: col(r.cells, 'AIR MILES FROM LAKE CHARLES'),
        source_url: col(r.cells, 'SOURCE URL'),
      },
    }))
}
export function analyzeProspects(
  rows,
  companies = [],
  territories = [],
  categories = [],
  cityMap = [],
) {
  const entries = [
    ...rows
      .filter((r) => !['excluded', 'linked'].includes(r.status))
      .map((r) => ({
        id: r.id,
        kind: 'import',
        program_id: r.program_id,
        facility_id: r.facility_id,
        record: r.record,
        source: r,
      })),
    ...companies.map((c) => ({
      id: c.id,
      kind: 'company',
      record: c,
      source: c,
    })),
  ]
  const index = new Map(),
    addresses = new Map(),
    grams = []
  entries.forEach((e, i) => {
    grams[i] = trigrams(e.record.name)
    for (const g of grams[i]) {
      if (!index.has(g)) index.set(g, [])
      index.get(g).push(i)
    }
    const addr = addressKey(e.record.address_line1)
    if (addr) {
      if (!addresses.has(addr)) addresses.set(addr, [])
      addresses.get(addr).push(i)
    }
  })
  const result = new Map()
  entries.forEach((e, i) => {
    if (e.kind !== 'import') return
    const r = e.record,
      issues = [],
      candidates = [],
      possible = new Map()
    for (const g of grams[i])
      for (const j of index.get(g) || [])
        if (i !== j) possible.set(j, (possible.get(j) || 0) + 1)
    for (const j of addresses.get(addressKey(r.address_line1)) || [])
      if (i !== j && !possible.has(j)) possible.set(j, 0)
    for (const [j, shared] of possible) {
      const d = entries[j]
      if (
        d.kind === 'import' &&
        e.facility_id &&
        d.facility_id !== e.facility_id
      )
        continue
      const score = (2 * shared) / (grams[i].size + grams[j].size),
        sameName =
          !!normalize(r.name) && normalize(r.name) === normalize(d.record.name),
        sameAddress =
          !!addressKey(r.address_line1) &&
          addressKey(r.address_line1) === addressKey(d.record.address_line1)
      if (!sameName && score < 0.72 && !(sameAddress && score >= 0.4)) continue
      if (
        e.source.company_id &&
        d.kind === 'company' &&
        e.source.company_id === d.id
      )
        continue
      const fields = []
      for (const [key, label, norm] of [
        ['name', 'Name', normalize],
        ['address_line1', 'Address', addressKey],
        ['city', 'City', normalize],
        ['state', 'State', normalize],
        ['zip', 'ZIP', normalize],
        ['phone', 'Phone', (v) => clean(v).replace(/\D/g, '')],
        ['territory', 'Territory', normalize],
      ])
        if (norm(r[key]) !== norm(d.record[key])) fields.push(label)
      if (
        (d.kind === 'company' || d.program_id === e.program_id) &&
        categoryKey(r.category) !== categoryKey(d.record.category)
      )
        fields.push('Category')
      candidates.push({
        id: d.id,
        kind: d.kind,
        program_id: d.program_id,
        company_id: d.source.company_id,
        source_name: d.source.source_name,
        row_number: d.source.row_number,
        record: d.record,
        score,
        fields,
        reason: fields.length
          ? fields.join(', ') + ' differ'
          : d.kind === 'import' && e.program_id !== d.program_id
            ? 'Same company may serve both programs'
            : 'Possible duplicate company/location',
      })
    }
    for (const [key, label] of [
      ['name', 'Company name'],
      ['address_line1', 'Address'],
      ['city', 'City'],
      ['state', 'State'],
      ['zip', 'ZIP'],
      ['category', 'Category'],
      ['territory', 'Territory'],
    ])
      if (!clean(r[key])) issues.push(label + ' missing')
    if (r.state && !/^[A-Za-z]{2}$/.test(r.state))
      issues.push('State requires review')
    if (r.zip && !/^\d{5}(-\d{4})?$/.test(r.zip))
      issues.push('ZIP requires review')
    const phone = phoneProblem(r.phone)
    if (phone) issues.push(phone)
    if (
      territories.length &&
      r.territory &&
      !territories.some((t) => normalize(t.name) === normalize(r.territory))
    )
      issues.push('Territory is not configured for this campus')
    if (
      categories.length &&
      r.category &&
      !categories.some((c) => categoryKey(c.name) === categoryKey(r.category))
    )
      issues.push('Category is not configured')
    const city = cityMap.find((c) => normalize(c.city) === normalize(r.city)),
      mapped = territories.find((t) => t.id === city?.territory_id)
    if (mapped && normalize(mapped.name) !== normalize(r.territory))
      issues.push(
        'City map assigns ' +
          mapped.name +
          '; workbook says ' +
          (r.territory || 'unassigned'),
      )
    candidates.sort(
      (a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name),
    )
    const phoneSuggestions = [
      ...new Set(
        candidates
          .filter(
            (c) =>
              normalize(r.name) === normalize(c.record.name) &&
              addressKey(r.address_line1) ===
                addressKey(c.record.address_line1) &&
              normalize(r.city) === normalize(c.record.city) &&
              !phoneProblem(c.record.phone),
          )
          .map((c) => c.record.phone),
      ),
    ]
    result.set(e.id, {
      issues,
      candidates,
      phoneSuggestions,
      suggestion: candidates.length
        ? 'Compare the listed records and verify the company and physical location before linking. Address or territory differences may be legitimate.'
        : issues.length
          ? 'Confirm the flagged fields with the company, then enter the verified details.'
          : 'No likely match found. Verify this is a new company before adding it.',
    })
  })
  return result
}
