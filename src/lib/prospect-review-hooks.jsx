import { useEffect, useState } from 'react'
import { useApp, useQuery, fetchAll } from './data'
import { supabase } from './supabase'
export function useProspectReview() {
  const app = useApp(),
    q = useQuery(
      () =>
        fetchAll(() =>
          supabase
            .from('prospect_import_rows')
            .select(
              '*,program:facility_programs(name,code),facility:facilities(name),territory:territories(name)',
            )
            .order('imported_at')
            .order('id'),
        ),
      [app.facilityId],
    )
  const directory = useQuery(
    () =>
      fetchAll(() =>
        supabase
          .from('facility_companies')
          .select(
            '*,company:companies(*,category:categories(name)),territory:territories(name)',
          )
          .order('facility_id')
          .order('company_id'),
      ),
    [app.facilityId],
  )
  const registry = useQuery(
    () =>
      fetchAll(() =>
        supabase
          .from('companies')
          .select('*,category:categories(name)')
          .eq('active', true)
          .is('merged_into_id', null)
          .order('id'),
      ),
    [app.facilityId],
  )
  const [analysis, setAnalysis] = useState(new Map()),
    [scanning, setScanning] = useState(false),
    [scanError, setScanError] = useState('')
  useEffect(() => {
    if (
      q.loading ||
      directory.loading ||
      registry.loading ||
      q.error ||
      directory.error ||
      registry.error
    )
      return
    if (!q.rows.length) {
      setAnalysis(new Map())
      return
    }
    setScanning(true)
    setScanError('')
    const worker = new Worker(
      new URL('./prospect-review.worker.js', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (e) => {
      if (e.data.error) setScanError(e.data.error)
      else setAnalysis(new Map(e.data.results))
      setScanning(false)
    }
    worker.onerror = () => {
      setScanError('The comparison could not finish. Refresh and try again.')
      setScanning(false)
    }
    worker.postMessage({
      rows: q.rows,
      directory: directory.rows,
      registry: registry.rows,
      territories: app.lookups.territories || [],
      categories: app.lookups.categories || [],
      cityMap: app.lookups.territoryCities || [],
      facilityId: app.facilityId,
    })
    return () => worker.terminate()
  }, [
    q.rows,
    directory.rows,
    registry.rows,
    q.loading,
    directory.loading,
    registry.loading,
    q.error,
    directory.error,
    registry.error,
    app.lookups,
    app.facilityId,
  ])
  return {
    ...q,
    loading: q.loading || directory.loading || registry.loading,
    unavailable: Boolean(
      q.error &&
      /prospect_import_rows.*schema cache|relation.*prospect_import_rows.*does not exist/i.test(
        q.error,
      ),
    ),
    analysis,
    scanning,
    scanError,
    directory: directory.rows,
    registry: registry.rows,
    error: q.error || directory.error || registry.error,
    refresh: () => {
      q.refresh()
      directory.refresh()
      registry.refresh()
    },
  }
}
