import { analyzeProspects } from './prospect-review.js'
self.onmessage = ({ data }) => {
  try {
    const results = []
    for (const facility of new Set(data.rows.map((r) => r.facility_id))) {
      const rows = data.rows.filter((r) => r.facility_id === facility)
      const companies = data.directory
        .filter(
          (fc) =>
            fc.facility_id === facility &&
            fc.company &&
            !fc.company.merged_into_id,
        )
        .map((fc) => ({
          ...fc.company,
          territory: fc.territory?.name || '',
          territory_id: fc.territory_id,
          category: fc.company.category?.name || '',
        }))
      for (const c of data.registry || [])
        if (!companies.some((x) => x.id === c.id))
          companies.push({
            ...c,
            territory: '',
            category: c.category?.name || '',
          })
      results.push(
        ...analyzeProspects(
          rows,
          companies,
          facility === data.facilityId ? data.territories : [],
          data.categories,
          facility === data.facilityId ? data.cityMap : [],
        ),
      )
    }
    self.postMessage({ results })
  } catch (e) {
    self.postMessage({ error: e.message })
  }
}
